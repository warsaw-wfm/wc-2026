/**
 * fetch-results.js
 * Runs via GitHub Actions (server-side, no CORS).
 * Fetches finished WC 2026 matches from football-data.org,
 * scores predictions, and updates Firestore.
 *
 * Smart scheduling logic:
 *   - Exits IMMEDIATELY (zero Firestore/API calls) if no match is in the
 *     check window (kickoff+2h → kickoff+6h).
 *   - Within the window, retries every 15 min via cron until result lands.
 *   - Stops checking a match after kickoff+6h (assumed delayed/cancelled).
 *
 * Required env vars:
 *   FOOTBALL_API_KEY          — football-data.org token
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON (as a string)
 */

'use strict';
const https = require('https');
const admin = require('firebase-admin');

const MATCHES   = require('./matches-index.json');
const now       = Date.now();
const TWO_HOURS = 2 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

console.log(`[${new Date().toISOString()}] Starting WC result sync… (${MATCHES.length} fixtures)`);

// ── Step 0: Pre-screen using ONLY the local matches index (zero external calls) ─
// Only proceed if at least one match sits in the check window: kickoff+2h → kickoff+6h
// This means: match has been played (2h grace for extra time), but we haven't
// given up yet (6h cap).  Outside this window the run costs nothing.
const inWindow = MATCHES.filter(m => {
  const ko = new Date(m.kickoffUTC).getTime();
  return ko + TWO_HOURS <= now && now <= ko + SIX_HOURS;
});

if (inWindow.length === 0) {
  console.log('No matches in check window (kickoff+2h … kickoff+6h) — exiting with 0 calls.');
  process.exit(0);
}

console.log(`${inWindow.length} match(es) in window: ${inWindow.map(m => `${m.teamA} vs ${m.teamB}`).join(', ')}`);

// ── Firebase Admin ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Scoring (mirror of app.js) ────────────────────────────────────────────────
function calculatePoints(pA, pB, rA, rB) {
  if (pA === rA && pB === rB) return 13;
  const predWin = pA > pB ? 1 : pA < pB ? -1 : 0;
  const realWin = rA > rB ? 1 : rA < rB ? -1 : 0;
  return predWin === realWin ? 10 : 0;
}

// ── Fetch from football-data.org ──────────────────────────────────────────────
function fetchAPI(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.football-data.org',
      path,
      headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API error ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── Step 1: Load already-completed match IDs from Firestore (1 read) ─────────
  const completedSnap = await db.collection('matches').where('status', '==', 'completed').get();
  const completedIds  = new Set();
  completedSnap.forEach(d => completedIds.add(d.id));
  console.log(`Firestore: ${completedIds.size} match(es) already completed`);

  // Safety guard: if Firestore returned 0 completed IDs but we know matches have
  // been completed for weeks, something is wrong (quota exhaustion, rules issue).
  // Use total fixtures kicked off >8h ago as a proxy for expected completions.
  const oldMatches = MATCHES.filter(m => new Date(m.kickoffUTC).getTime() + 8 * 60 * 60 * 1000 < now);
  if (completedIds.size === 0 && oldMatches.length > 5) {
    console.error(`Safety abort: Firestore returned 0 completed matches but ${oldMatches.length} fixtures are >8h old. Possible quota/rules issue.`);
    process.exit(1);
  }

  // ── Step 2: Filter inWindow to genuinely pending (not yet completed) ──────────
  const pending = inWindow.filter(m => !completedIds.has(m.matchId));

  if (pending.length === 0) {
    console.log('All window matches already completed — nothing to do.');
    process.exit(0);
  }

  console.log(`${pending.length} pending match(es) to fetch: ${pending.map(m => `${m.teamA} vs ${m.teamB}`).join(', ')}`);

  // ── Step 3: Save rank snapshot BEFORE scoring (captures pre-match standings) ──
  try {
    const usersSnap = await db.collection('users').get();
    const ranked = [];
    usersSnap.forEach(d => {
      if (!d.data().disabled) ranked.push({ id: d.id, pts: d.data().totalPoints || 0 });
    });
    ranked.sort((a, b) => b.pts - a.pts);
    const rankMap = {};
    ranked.forEach((u, i) => { rankMap[u.id] = i + 1; });
    await db.collection('config').doc('rankSnapshot').set({
      ranks: rankMap,
      savedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Rank snapshot saved: ${ranked.length} users`);
  } catch (e) {
    console.warn('Could not save rank snapshot:', e.message);
  }

  // ── Step 4: Fetch results for just the pending date range ─────────────────────
  const dates    = pending.map(m => new Date(m.kickoffUTC));
  const dateFrom = new Date(Math.min(...dates)).toISOString().slice(0, 10);
  const dateTo   = new Date(Math.max(...dates) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let data;
  try {
    data = await fetchAPI(`/v4/competitions/WC/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`);
  } catch (e) {
    console.warn('Date-range fetch failed, retrying with season=2026…', e.message);
    data = await fetchAPI(`/v4/competitions/WC/matches?status=FINISHED&season=2026&dateFrom=${dateFrom}&dateTo=${dateTo}`);
  }

  const finished = (data.matches || []).filter(m => m.status === 'FINISHED');
  console.log(`API returned ${finished.length} finished match(es) in range ${dateFrom} → ${dateTo}`);

  // Known team name variations between our index and football-data.org
  const TEAM_ALIASES = {
    'Korea Republic':       'South Korea',
    'Czech Republic':       'Czechia',
    'United States':        'USA',
    'IR Iran':              'Iran',
    "Côte d'Ivoire":       'Ivory Coast',
    'Ivory Coast':          'Ivory Coast',
    'Türkiye':              'Turkey',
    'Bosnia-Herzegovina':   'Bosnia & Herzegovina',
    'Bosnia and Herzegovina': 'Bosnia & Herzegovina',
    'Curaçao':              'Curaçao',   // ensure consistent form
    'Curacao':              'Curaçao',
  };

  // Normalise: strip accents via Unicode decomposition, then remove non-alpha.
  // e.g. Curaçao → Curacao → curacao (matches both API spellings and our index)
  function normalise(name) {
    return (TEAM_ALIASES[name] || name)
      .normalize('NFD')                 // decompose accented chars: ç → c + combining cedilla
      .replace(/[̀-ͯ]/g, '')  // remove all combining diacritical marks
      .toLowerCase()
      .replace(/[^a-z]/g, '');          // remove remaining non-alpha
  }

  // Build a lookup map from normalised team pair → our pending match.
  // This is the primary (most reliable) matching strategy.
  const pendingByTeams = new Map();
  for (const m of pending) {
    const key = `${normalise(m.teamA)}|${normalise(m.teamB)}`;
    pendingByTeams.set(key, m);
  }

  // Track which pending matches have been claimed to avoid double-assignment.
  const claimed = new Set();

  let updated = 0;

  for (const apiMatch of finished) {
    const rA = apiMatch.score?.fullTime?.home;
    const rB = apiMatch.score?.fullTime?.away;
    if (rA == null || rB == null) continue;

    const apiTime  = new Date(apiMatch.utcDate).getTime();
    const apiHomeN = normalise(apiMatch.homeTeam?.name || '');
    const apiAwayN = normalise(apiMatch.awayTeam?.name || '');

    // Primary: match by TEAM NAMES (most reliable, handles simultaneous kickoffs)
    const teamKey = `${apiHomeN}|${apiAwayN}`;
    let ourMatch = pendingByTeams.get(teamKey);
    if (ourMatch && claimed.has(ourMatch.matchId)) ourMatch = null; // already used

    // Fallback: match by kickoff time ±15 min (only if name match failed)
    if (!ourMatch) {
      ourMatch = pending.find(m =>
        !claimed.has(m.matchId) &&
        Math.abs(new Date(m.kickoffUTC).getTime() - apiTime) < 15 * 60 * 1000
      );
      if (ourMatch) {
        console.log(`  ⚠️  Name mismatch — time-matched ${apiMatch.homeTeam?.name} vs ${apiMatch.awayTeam?.name} → ${ourMatch.teamA} vs ${ourMatch.teamB}`);
      }
    }

    if (!ourMatch) {
      console.log(`  ⏭  No pending match for: ${apiMatch.homeTeam?.name} vs ${apiMatch.awayTeam?.name} @ ${apiMatch.utcDate}`);
      continue;
    }

    claimed.add(ourMatch.matchId); // mark as used so no duplicate assignment

    // Write result to Firestore
    await db.collection('matches').doc(ourMatch.matchId).set(
      { resultA: rA, resultB: rB, status: 'completed' },
      { merge: true }
    );

    // Score all predictions for this match
    const predsSnap = await db.collection('predictions')
      .where('matchId', '==', ourMatch.matchId).get();

    const predBatch = db.batch();
    const deltas    = {};
    predsSnap.forEach(doc => {
      const p   = doc.data();
      const pts = calculatePoints(p.predictedA, p.predictedB, rA, rB);
      const prev = p.pointsAwarded ?? 0;
      predBatch.update(doc.ref, { pointsAwarded: pts });
      deltas[p.userId] = (deltas[p.userId] || 0) + (pts - prev);
    });
    await predBatch.commit();

    // Update user totals in one batch
    const userBatch = db.batch();
    for (const [uid, delta] of Object.entries(deltas)) {
      if (delta === 0) continue;
      const uRef  = db.collection('users').doc(uid);
      const uSnap = await uRef.get();
      if (uSnap.exists) {
        userBatch.update(uRef, { totalPoints: (uSnap.data().totalPoints || 0) + delta });
      }
    }
    await userBatch.commit();

    console.log(`  ✅ ${ourMatch.teamA} ${rA}–${rB} ${ourMatch.teamB} · ${predsSnap.size} prediction(s) scored`);
    updated++;
  }

  // Write last-sync timestamp
  await db.collection('config').doc('lastSync').set({
    syncedAt:       admin.firestore.FieldValue.serverTimestamp(),
    matchesUpdated: updated
  });

  console.log(`Done. ${updated} match(es) updated.`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

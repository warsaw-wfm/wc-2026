/**
 * fetch-results.js
 * Runs via GitHub Actions (server-side, no CORS).
 * Fetches finished WC 2026 matches from football-data.org,
 * scores predictions, and updates Firestore.
 *
 * Required env vars:
 *   FOOTBALL_API_KEY          — football-data.org token
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON (as a string)
 */

'use strict';
const https   = require('https');
const path    = require('path');
const admin   = require('firebase-admin');

// ── Load MATCHES index (matchId + kickoffUTC + teams) ─────────────────────────
const MATCHES = require('./matches-index.json');
console.log('Fixtures loaded:', MATCHES.length);

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
  console.log(`[${new Date().toISOString()}] Starting WC result sync…`);

  const now = Date.now();

  // ── Step 1: Bulk-fetch already-completed match IDs from Firestore (1 query) ──
  const completedSnap = await db.collection('matches').where('status', '==', 'completed').get();
  const completedIds  = new Set();
  completedSnap.forEach(d => completedIds.add(d.id));
  console.log(`Firestore: ${completedIds.size} match(es) already completed`);

  // ── Step 2: Find matches that have kicked off but aren't completed yet ────────
  const pending = MATCHES.filter(m =>
    new Date(m.kickoffUTC).getTime() + 2 * 60 * 60 * 1000 < now &&  // kicked off >2h ago
    !completedIds.has(m.matchId)
  );

  if (pending.length === 0) {
    console.log('No pending matches — skipping API call.');
    await db.collection('config').doc('lastSync').set({
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      matchesUpdated: 0
    });
    console.log('Done. 0 match(es) updated.');
    process.exit(0);
  }

  console.log(`${pending.length} pending match(es) to check:`, pending.map(m => `${m.teamA} vs ${m.teamB}`).join(', '));

  // ── Step 3: Fetch only the date range covering pending matches from the API ───
  const dates     = pending.map(m => new Date(m.kickoffUTC));
  const dateFrom  = new Date(Math.min(...dates)).toISOString().slice(0, 10);
  const dateTo    = new Date(Math.max(...dates) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let data;
  try {
    data = await fetchAPI(`/v4/competitions/WC/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`);
  } catch (e) {
    console.warn('Date-range fetch failed, retrying with season=2026…', e.message);
    data = await fetchAPI(`/v4/competitions/WC/matches?status=FINISHED&season=2026&dateFrom=${dateFrom}&dateTo=${dateTo}`);
  }

  const finished = (data.matches || []).filter(m => m.status === 'FINISHED');
  console.log(`Found ${finished.length} finished match(es) from API in range ${dateFrom} → ${dateTo}`);

  let updated = 0;

  // Known team name variations between our index and football-data.org
  const TEAM_ALIASES = {
    'Korea Republic': 'South Korea',
    'Czech Republic': 'Czechia',
    'United States': 'USA',
    'IR Iran': 'Iran',
    'Côte d\'Ivoire': 'Ivory Coast',
    'Türkiye': 'Turkey',
  };
  function normalise(name) {
    return (TEAM_ALIASES[name] || name).toLowerCase().replace(/[^a-z]/g, '');
  }

  for (const apiMatch of finished) {
    const rA = apiMatch.score?.fullTime?.home;
    const rB = apiMatch.score?.fullTime?.away;
    if (rA == null || rB == null) continue;

    const apiTime  = new Date(apiMatch.utcDate).getTime();
    const apiHomeN = normalise(apiMatch.homeTeam?.name || '');
    const apiAwayN = normalise(apiMatch.awayTeam?.name || '');

    // Primary: match by kickoff time (±15 min tolerance)
    let ourMatch = pending.find(
      m => Math.abs(new Date(m.kickoffUTC).getTime() - apiTime) < 15 * 60 * 1000
    );

    // Fallback: match by team names if time didn't match
    if (!ourMatch) {
      ourMatch = pending.find(m =>
        normalise(m.teamA) === apiHomeN && normalise(m.teamB) === apiAwayN
      );
      if (ourMatch) console.log(`  ⚠️  Time mismatch for ${apiMatch.homeTeam?.name} vs ${apiMatch.awayTeam?.name} — matched by team names`);
    }

    if (!ourMatch) {
      console.log(`  ⏭  No match for API fixture: ${apiMatch.homeTeam?.name} vs ${apiMatch.awayTeam?.name} @ ${apiMatch.utcDate}`);
      continue;
    }

    // Write result to Firestore
    const matchRef = db.collection('matches').doc(ourMatch.matchId);
    await matchRef.set({ resultA: rA, resultB: rB, status: 'completed' }, { merge: true });

    // Score all predictions for this match
    const predsSnap = await db.collection('predictions')
      .where('matchId', '==', ourMatch.matchId).get();

    const predBatch = db.batch();
    const deltas = {};

    predsSnap.forEach(doc => {
      const p    = doc.data();
      const pts  = calculatePoints(p.predictedA, p.predictedB, rA, rB);
      const prev = p.pointsAwarded ?? 0;
      predBatch.update(doc.ref, { pointsAwarded: pts });
      deltas[p.userId] = (deltas[p.userId] || 0) + (pts - prev);
    });

    await predBatch.commit();

    // Update user total points
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

  // Write last-sync timestamp to Firestore so the app can show it
  await db.collection('config').doc('lastSync').set({
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    matchesUpdated: updated
  });

  console.log(`Done. ${updated} match(es) updated.`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.MotionJudge.BACKOFF_MS;
import static com.roamkeep.app.geofence.MotionJudge.BACKOFF_RESET_MS;
import static com.roamkeep.app.geofence.MotionJudge.CHECK;
import static com.roamkeep.app.geofence.MotionJudge.MOVING;
import static com.roamkeep.app.geofence.MotionJudge.SRC_FOOT;
import static com.roamkeep.app.geofence.MotionJudge.SRC_ROUGH;
import static com.roamkeep.app.geofence.MotionJudge.SRC_SENSOR;
import static com.roamkeep.app.geofence.MotionJudge.SRC_VEHICLE;
import static com.roamkeep.app.geofence.MotionJudge.SRC_WIFI;
import static com.roamkeep.app.geofence.MotionJudge.STILL;
import static com.roamkeep.app.geofence.MotionJudge.UNKNOWN;
import static com.roamkeep.app.geofence.MotionJudge.WATCH;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The rules for leaving the low-power profile (4.13.0). Wrong one way, a
 * phone drives off and nobody is told (2026-11-10: a stale position near home
 * five minutes into a school run). Wrong the other way, a phone on a table
 * runs GPS for hours (2026-11-09: 19 false starts in a day). Both failures
 * are silent, so both directions are pinned here.
 */
public class MotionJudgeTest {
    // Metres north of the equator as degrees, on metresBetween's sphere.
    private static double north(double m) { return Math.toDegrees(m / 6_371_000); }

    private static final float NO_SPEED = 0f;
    private static final MotionJudge.Anchor HOME = MotionJudge.Anchor.of(0, 0, 12f);

    private static int judge(double northM, float acc, float speed, MotionJudge.Anchor a) {
        return MotionJudge.judgeFix(north(northM), 0, acc, speed, a);
    }

    // ── Which fixes decide ───────────────────────────────────────────────

    @Test public void onlyAPreciseFixDecides() {
        assertTrue(MotionJudge.decisive(5f));
        assertTrue(MotionJudge.decisive(49.9f));
        assertFalse("50 m is the speed-trust line, and it is exclusive", MotionJudge.decisive(50f));
        assertFalse(MotionJudge.decisive(100f));
        assertFalse("no accuracy is not precise", MotionJudge.decisive(-1f));
    }

    @Test public void aRoughFixNeverSettlesAnything() {
        // Far away or right here, a ±100 m fix is UNKNOWN: on 2026-11-10 it was
        // the rough fixes that were wrong.
        assertEquals(UNKNOWN, judge(2_000, 100f, NO_SPEED, HOME));
        assertEquals(UNKNOWN, judge(5, 100f, NO_SPEED, HOME));
        // A fuzzy fix invents speed: never trusted.
        assertEquals(UNKNOWN, judge(5, 80f, 12f, HOME));
    }

    @Test public void aPreciseFixFarFromTheAnchorIsMoving() {
        assertEquals(MOVING, judge(900, 8f, NO_SPEED, HOME));
        assertEquals(MOVING, judge(41, 8f, NO_SPEED, HOME));
    }

    @Test public void aPreciseFixNearTheAnchorIsStill() {
        assertEquals(STILL, judge(39, 8f, NO_SPEED, HOME));
        assertEquals(STILL, judge(0, 8f, NO_SPEED, HOME));
    }

    @Test public void theBarIsDetectMovingsOwnNotAHigherOne() {
        // max(MOVING_DISP_M, acc x MOVING_ACC_MULT): 40 m at ±8, 60 m at ±40.
        assertEquals(40.0, MotionJudge.movingBar(8f, null), 0.001);
        assertEquals(60.0, MotionJudge.movingBar(40f, null), 0.001);
        assertEquals(STILL, judge(59, 40f, NO_SPEED, HOME));
        assertEquals(MOVING, judge(61, 40f, NO_SPEED, HOME));
    }

    @Test public void aTrustedSpeedAloneIsMoving() {
        // Walking pace from a GPS fix standing on the anchor: moving.
        assertEquals(MOVING, judge(0, 10f, 1.2f, HOME));
        assertEquals(STILL, judge(0, 10f, 0.3f, HOME));
    }

    @Test public void withNoAnchorAPreciseFixIsStillAndBecomesOne() {
        assertEquals(STILL, judge(500, 8f, NO_SPEED, null));
        assertEquals(MOVING, judge(500, 8f, 3f, null));
    }

    // ── The anchor ───────────────────────────────────────────────────────

    @Test public void theAnchorIsWeightedByAccuracy() {
        // Seeded by a rough fix 100 m out, then one GPS fix on the spot: the
        // GPS fix carries 100x the weight, so the anchor moves almost all the
        // way to it, and takes its accuracy.
        MotionJudge.Anchor a = MotionJudge.Anchor.of(north(100), 0, 100f).fold(0, 0, 10f);
        double off = GeofenceReceiver.metresBetween(0, 0, a.lat, a.lng);
        assertTrue("anchor " + off + " m from the GPS fix", off < 1.5);
        assertEquals(10f, a.acc, 0.001f);
    }

    @Test public void aRoughAnchorWidensTheBarUntilAPreciseFixArrives() {
        MotionJudge.Anchor rough = MotionJudge.Anchor.of(0, 0, 90f);
        assertEquals(90.0, MotionJudge.movingBar(8f, rough), 0.001);
        assertEquals(STILL, judge(80, 8f, NO_SPEED, rough));
        MotionJudge.Anchor better = rough.fold(north(80), 0, 8f);
        assertEquals(40.0, MotionJudge.movingBar(8f, better), 0.001);
    }

    // ── Signals ──────────────────────────────────────────────────────────

    @Test public void strongSignalsWatchAndWeakOnesCheck() {
        assertEquals(WATCH, MotionJudge.responseFor(SRC_VEHICLE));
        assertEquals(WATCH, MotionJudge.responseFor(SRC_WIFI));
        assertEquals(CHECK, MotionJudge.responseFor(SRC_FOOT));
        assertEquals(CHECK, MotionJudge.responseFor(SRC_SENSOR));
        assertEquals(CHECK, MotionJudge.responseFor(SRC_ROUGH));
    }

    @Test public void aCheckGoesDenseOnMovingAndOnNoAnswerOnlyForARoughPosition() {
        for (int src : new int[] { SRC_FOOT, SRC_SENSOR, SRC_ROUGH }) {
            assertTrue(MotionJudge.checkGoesDense(MOVING, src));
            assertFalse(MotionJudge.checkGoesDense(STILL, src));
        }
        assertTrue("unknown is moving, for the signal that used to go dense",
                MotionJudge.checkGoesDense(UNKNOWN, SRC_ROUGH));
        assertFalse(MotionJudge.checkGoesDense(UNKNOWN, SRC_SENSOR));
        assertFalse(MotionJudge.checkGoesDense(UNKNOWN, SRC_FOOT));
    }

    @Test public void aRoughPositionAsksOnlyBeyondTheBar() {
        assertFalse(MotionJudge.roughAsksForCheck(140, 100f, HOME, true, 0));
        assertTrue(MotionJudge.roughAsksForCheck(160, 100f, HOME, true, 0));
    }

    @Test public void provenDriftIsNotCheckedAgain() {
        // Drift reached 170 m and a check said still. Another 160 m wobble
        // never asks, backoff or not.
        assertFalse(MotionJudge.roughAsksForCheck(160, 100f, HOME, true, 170));
        assertFalse(MotionJudge.roughAsksForCheck(160, 100f, HOME, false, 170));
        // A little further out asks only if the backoff allows.
        assertTrue(MotionJudge.roughAsksForCheck(200, 100f, HOME, true, 170));
        assertFalse(MotionJudge.roughAsksForCheck(330, 100f, HOME, false, 170));
    }

    @Test public void wellBeyondProvenDriftAlwaysAsks() {
        // 600 m is not drift: it asks whatever the backoff says, so a
        // backoff can never hide the start of a real trip.
        assertTrue(MotionJudge.roughAsksForCheck(600, 100f, HOME, false, 170));
        assertTrue(MotionJudge.roughAsksForCheck(341, 100f, HOME, false, 170));
        // With nothing proven yet, anything past the bar asks.
        assertTrue(MotionJudge.roughAsksForCheck(151, 100f, HOME, false, 0));
    }

    @Test public void activityEventsMustBeFresh() {
        long now = 10_000L * 1_000_000_000L;
        assertTrue(MotionJudge.freshEvent(now - 30L * 1_000_000_000L, now));
        assertTrue(MotionJudge.freshEvent(now - 179L * 1_000_000_000L, now));
        assertFalse(MotionJudge.freshEvent(now - 181L * 1_000_000_000L, now));
        assertFalse("from another boot", MotionJudge.freshEvent(now + 3_600L * 1_000_000_000L, now));
    }

    // ── Backoff ──────────────────────────────────────────────────────────

    @Test public void theFirstSignalAlwaysActs() {
        MotionJudge.Backoff b = new MotionJudge.Backoff();
        assertTrue(b.allow(1_000));
    }

    @Test public void theLadderClimbsAndCaps() {
        MotionJudge.Backoff b = new MotionJudge.Backoff();
        long t = 1_000_000;
        for (int i = 0; i < BACKOFF_MS.length + 2; i++) {
            assertTrue(b.allow(t));
            b.onNothing(t);
            long wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
            assertFalse(b.allow(t + wait - 1));
            t += wait;
        }
        assertEquals(15 * 60_000L, BACKOFF_MS[BACKOFF_MS.length - 1]);
    }

    @Test public void anHourOfSilenceResetsTheLadder() {
        MotionJudge.Backoff b = new MotionJudge.Backoff();
        long t = 1_000_000;
        for (int i = 0; i < 4; i++) { b.allow(t); b.onNothing(t); t += 20 * 60_000; }
        // Overnight Wi-Fi flaps climbed it; the morning's first loss acts,
        // and if that one is nothing too, the wait is the FIRST step again,
        // not the 15 minutes the night had reached.
        long morning = t + BACKOFF_RESET_MS + 1;
        assertTrue(b.allow(morning));
        b.onNothing(morning);
        assertFalse(b.allow(morning + BACKOFF_MS[0] - 1));
        assertTrue(b.allow(morning + BACKOFF_MS[0]));
    }

    // ── The journal line ─────────────────────────────────────────────────

    // ── What decided "moving" (4.13.1) ──────────────────────────────────

    @Test public void aSpeedThatDecidedIsNamedWithTheFix() {
        // judgeFix checks speed first, so the line says speed even when the
        // distance would also have cleared the bar.
        assertEquals(MOVING, judge(500, 8f, 2.6f, HOME));
        assertEquals("fix ±8m at 9.4 km/h", MotionJudge.movingWhy(8f, 2.6f, 500));
    }

    @Test public void aDistanceThatDecidedIsNamedWithTheFix() {
        assertEquals(MOVING, judge(64, 8f, NO_SPEED, HOME));
        assertEquals("fix ±8m, 64m from where it stopped", MotionJudge.movingWhy(8f, NO_SPEED, 64.4));
        assertEquals("fix ±12m, 1.3km from where it stopped",
                MotionJudge.movingWhy(12f, 0.6f, 1_300));   // at the speed bar, not over it
    }

    @Test public void noAnchorSaysOnlyTheFix() {
        assertEquals("fix ±8m", MotionJudge.movingWhy(8f, NO_SPEED, -1));
    }

    @Test public void theCheckLineSaysCountsAndSourcesOnly() {
        int[] by = new int[MotionJudge.SOURCES];
        by[SRC_SENSOR] = 4;
        by[SRC_ROUGH] = 2;
        assertEquals("move: 6 checks in 30m: 5 still, 1 no GPS fix (motion sensor 4, rough position 2)",
                MotionJudge.checkLine(0, 5, 1, by, 30 * 60_000L + 59_000));
        int[] one = new int[MotionJudge.SOURCES];
        one[SRC_FOOT] = 1;
        assertEquals("move: 1 check in 0m: 1 moving (activity: on foot 1)",
                MotionJudge.checkLine(1, 0, 0, one, 5_000));
    }

    // ── Replays ──────────────────────────────────────────────────────────

    /**
     * 2026-11-10, a school run. The car left at 08:20 (two other phones in it
     * agree); this phone reported a position near home at about 08:25 and
     * nothing switched to GPS until 08:29:44 at the school.
     */
    @Test public void schoolRunReplay() {
        MotionJudge.Backoff wifi = new MotionJudge.Backoff();
        // 08:20: the car pulls away and the phone loses the home Wi-Fi. That
        // alone opens a watch: GPS for three minutes.
        assertTrue(wifi.allow(0));
        assertEquals(WATCH, MotionJudge.responseFor(SRC_WIFI));
        // Had the watch not happened: 08:25, the stale ±100 m position 60 m
        // from home. It settles nothing and asks for nothing...
        assertEquals(UNKNOWN, judge(60, 100f, NO_SPEED, HOME));
        assertFalse(MotionJudge.roughAsksForCheck(60, 100f, HOME, true, 0));
        // ...which is why the other signals exist: the first GPS fix on the
        // road, from the watch or a check, is moving.
        assertEquals(MOVING, judge(900, 8f, 14f, HOME));
        // And the vehicle signal, for a phone not on Wi-Fi, watches too.
        assertEquals(WATCH, MotionJudge.responseFor(SRC_VEHICLE));
    }

    /**
     * 2026-11-09, a phone on a table overnight. Its rough fixes wandered
     * 120 to 170 m from where it lay; each one more than the bar from the
     * previous fix switched GPS on. Now a rough fix asks for one check, the
     * check says still, and the ladder spaces the rest out.
     */
    @Test public void tableOvernightReplay() {
        MotionJudge.Backoff rough = new MotionJudge.Backoff();
        double provenDrift = 0;
        int checks = 0, dense = 0;
        // A rough fix every 7 minutes for 8 hours, wandering 150 to 175 m out.
        for (long t = 0; t < 8 * 3_600_000L; t += 7 * 60_000) {
            double d = 150 + (t / 60_000) % 26;
            if (!MotionJudge.roughAsksForCheck(d, 100f, HOME, rough.allow(t), provenDrift)) continue;
            checks++;
            int verdict = judge(6, 9f, NO_SPEED, HOME);   // GPS: on the table
            if (MotionJudge.checkGoesDense(verdict, SRC_ROUGH)) { dense++; continue; }
            rough.onNothing(t);
            provenDrift = Math.max(provenDrift, d);
        }
        assertEquals("no GPS watch all night", 0, dense);
        assertTrue("checks " + checks + " should be a few, not one a fix", checks <= 6);

        // And the morning: walking out of the door, rough fixes 600 m out ask
        // at once, backoff or not.
        assertTrue(MotionJudge.roughAsksForCheck(600, 100f, HOME, false, provenDrift));
    }
}

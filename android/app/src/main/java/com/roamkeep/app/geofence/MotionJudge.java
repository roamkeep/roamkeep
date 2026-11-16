package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.LocationForegroundService.MOVING_ACC_MULT;
import static com.roamkeep.app.geofence.LocationForegroundService.MOVING_DISP_M;
import static com.roamkeep.app.geofence.LocationForegroundService.MOVING_SPEED_MS;
import static com.roamkeep.app.geofence.LocationForegroundService.SPEED_TRUST_ACC_M;

/**
 * Has this phone started moving? The rules for leaving the low-power profile,
 * pure so MotionJudgeTest can pin them (4.13.0).
 *
 * Until 4.13.0 the low-power profile left low power on the strength of a
 * rough network position, and believed it both ways:
 *
 *  - A stale one said "still" while the phone drove away. On 2026-11-10 a
 *    phone reported a position near home five minutes into a school run, so
 *    nothing switched to GPS, the drive was never recorded and "left Home"
 *    came 9.5 minutes late. Play Services' fences, fed by the same positions,
 *    were fooled too. GPS itself was fine.
 *  - A drifting one said "moving" while the phone sat on a table: more than
 *    the bar from the PREVIOUS rough position, so GPS ran for three minutes
 *    or more, 19 times in one day at home.
 *
 * So: many signals may say "maybe moving" (activity recognition, the motion
 * sensor, leaving a Wi-Fi network, a rough position far from where the phone
 * stopped), and only a precise fix decides. A rough position can raise a
 * suspicion, never settle one.
 *
 * The bar for "moving" is detectMoving's own, with the same constants: never
 * raise it (the rule 4.5.4 broke twice). What changed is the reference. A
 * fix is judged against the ANCHOR, where the phone has been sitting, rather
 * than against the previous fix: drift is a random walk that stays near its
 * origin, travel accumulates away from it.
 */
final class MotionJudge {
    private MotionJudge() {}

    // Verdicts.
    static final int MOVING = 1;
    static final int STILL = 0;
    static final int UNKNOWN = -1;

    // Where a "maybe moving" came from. Each has its own backoff.
    static final int SRC_NONE = -1;
    static final int SRC_VEHICLE = 0;   // activity recognition: in a vehicle, on a bicycle
    static final int SRC_FOOT = 1;      // activity recognition: walking, running
    static final int SRC_SENSOR = 2;    // the significant-motion sensor
    static final int SRC_WIFI = 3;      // the last Wi-Fi network was lost
    static final int SRC_ROUGH = 4;     // a rough position far from the anchor
    static final int SOURCES = 5;

    /** What a signal asks for. */
    static final int WATCH = 0;   // GPS for STILL_AFTER_MS, as a doze exit does
    static final int CHECK = 1;   // one fresh GPS fix decides

    /** Strong signals open a watch; weak ones ask for one check. A strong
     *  signal is one that is rarely wrong when the phone is about to travel
     *  and rarely fires when it is not: a vehicle, or leaving the Wi-Fi.
     *  Walking and the motion sensor fire round the house all day. */
    static int responseFor(int source) {
        return source == SRC_VEHICLE || source == SRC_WIFI ? WATCH : CHECK;
    }

    static String sourceName(int source) {
        switch (source) {
            case SRC_VEHICLE: return "activity: vehicle";
            case SRC_FOOT:    return "activity: on foot";
            case SRC_SENSOR:  return "motion sensor";
            case SRC_WIFI:    return "left Wi-Fi";
            case SRC_ROUGH:   return "rough position";
            default:          return "start";
        }
    }

    /**
     * A fix decides only if it is precise. The same threshold as detectMoving
     * trusting a speed, and for the same reason: a low-power fix invents
     * speed and position alike. No accuracy at all is not precise.
     */
    static boolean decisive(float acc) {
        return acc >= 0 && acc < SPEED_TRUST_ACC_M;
    }

    /**
     * Where the phone has been sitting: an accuracy-weighted average of the
     * fixes that put it there, weighted 1/acc^2 so one GPS fix outweighs a
     * hundred rough ones. `acc` is the best accuracy folded in so far: the
     * anchor is no better than its best evidence, and an anchor seeded from a
     * rough fix says so until a precise one arrives.
     */
    static final class Anchor {
        final double lat, lng;
        final float acc;
        final double weight;

        private Anchor(double lat, double lng, float acc, double weight) {
            this.lat = lat; this.lng = lng; this.acc = acc; this.weight = weight;
        }

        static Anchor of(double lat, double lng, float acc) {
            float a = Math.max(acc, 1f);
            return new Anchor(lat, lng, a, 1.0 / ((double) a * a));
        }

        Anchor fold(double fLat, double fLng, float fAcc) {
            float a = Math.max(fAcc, 1f);
            double w = 1.0 / ((double) a * a);
            double total = weight + w;
            return new Anchor(
                    lat + (fLat - lat) * (w / total),
                    lng + (fLng - lng) * (w / total),
                    Math.min(acc, a), total);
        }
    }

    /** How far a fix must be from the anchor to count as travel: detectMoving's
     *  bar, plus the anchor's own uncertainty, because the anchor is itself an
     *  estimate. After the first precise fix that term is a few metres. */
    static double movingBar(float fixAcc, Anchor anchor) {
        double bar = Math.max(MOVING_DISP_M, Math.max(fixAcc, 0f) * MOVING_ACC_MULT);
        return anchor == null ? bar : Math.max(bar, anchor.acc);
    }

    /**
     * MOVING, STILL or UNKNOWN for one fix against the anchor.
     *
     * Only a precise fix returns MOVING or STILL. A trusted speed alone is
     * moving, as in detectMoving. With no anchor there is nothing to measure
     * against, so a precise fix without speed is STILL: it becomes the
     * anchor, and the next one is measured from it.
     */
    static int judgeFix(double lat, double lng, float acc, float speed, Anchor anchor) {
        if (!decisive(acc)) return UNKNOWN;
        if (speed > MOVING_SPEED_MS) return MOVING;
        if (anchor == null) return STILL;
        double d = GeofenceReceiver.metresBetween(anchor.lat, anchor.lng, lat, lng);
        return d > movingBar(acc, anchor) ? MOVING : STILL;
    }

    /**
     * Should a rough position ask for a check? Drift stays inside a radius
     * and travel leaves it, so the answer depends on how far out drift has
     * already been PROVEN to reach here (`provenDriftM`: the furthest rough
     * position a check has shown to be the phone sitting still):
     *
     *  - within the bar a precise fix would have to clear: no;
     *  - clearly beyond proven drift (twice as far, or one bar further): yes,
     *    whatever the backoff says, so a backoff can never hide a real start;
     *  - within proven drift: no, it has already been checked;
     *  - in between: if the backoff allows.
     *
     * A phone on a table therefore checks a few times while its drift
     * radius is learned, and then not at all; a ladder alone still allowed
     * one check every 15 minutes, all night.
     */
    static boolean roughAsksForCheck(double distM, float acc, Anchor anchor,
                                     boolean backoffAllows, double provenDriftM) {
        if (distM <= movingBar(acc, anchor)) return false;
        if (distM > Math.max(2 * provenDriftM, provenDriftM + MOVING_DISP_M)) return true;
        if (distM <= provenDriftM) return false;
        return backoffAllows;
    }

    /** What to do with a check's answer. A check that got no precise fix
     *  (indoors, usually) settles nothing: for a rough position that means
     *  GPS anyway, today's behaviour and the "unknown is moving" rule; for a
     *  sensor or walking signal it means staying put, because those fire
     *  round the house and the other signals cover a real departure. */
    static boolean checkGoesDense(int verdict, int source) {
        if (verdict == MOVING) return true;
        if (verdict == UNKNOWN) return source == SRC_ROUGH;
        return false;
    }

    // ── Backoff ─────────────────────────────────────────────────────────
    //
    // After a signal turns out to be nothing (its check or watch ended still),
    // the same source is ignored for the next step of this ladder. Someone
    // walking round the house, or a phone that drops its Wi-Fi in its sleep,
    // costs a handful of checks and then a few an hour, not one a minute.
    // The first signal of any source always acts, so a strong one is never
    // blind; any movement resets every ladder; an hour without a source
    // resets that one, so last night's ladder does not mute this morning.
    static final long[] BACKOFF_MS = { 60_000, 120_000, 240_000, 480_000, 900_000 };
    static final long BACKOFF_RESET_MS = 60 * 60_000;

    static final class Backoff {
        int level = 0;
        long untilMs = 0;
        long lastSeenMs = 0;

        /** A signal arrived at `now`: may it act? */
        boolean allow(long now) {
            if (lastSeenMs > 0 && now - lastSeenMs > BACKOFF_RESET_MS) reset();
            lastSeenMs = now;
            return now >= untilMs;
        }

        /** It turned out to be nothing. */
        void onNothing(long now) {
            untilMs = now + BACKOFF_MS[Math.min(level, BACKOFF_MS.length - 1)];
            if (level < BACKOFF_MS.length) level++;
        }

        void reset() { level = 0; untilMs = 0; }
    }

    /**
     * The half-hourly journal line for checks: counts and sources, never a
     * position. `bySource` is indexed by SRC_*.
     *   move: 6 checks in 30m: 5 still, 1 no GPS fix (motion sensor 4, rough position 2)
     */
    static String checkLine(int moving, int still, int none, int[] bySource, long spanMs) {
        int n = moving + still + none;
        StringBuilder sb = new StringBuilder("move: ").append(n)
                .append(n == 1 ? " check in " : " checks in ")
                .append(Math.max(0, spanMs) / 60_000).append("m: ");
        String sep = "";
        if (moving > 0) { sb.append(sep).append(moving).append(" moving"); sep = ", "; }
        if (still > 0)  { sb.append(sep).append(still).append(" still"); sep = ", "; }
        if (none > 0)   { sb.append(sep).append(none).append(" no GPS fix"); }
        sep = " (";
        for (int s = 0; s < SOURCES && s < bySource.length; s++) {
            if (bySource[s] <= 0) continue;
            sb.append(sep).append(sourceName(s)).append(' ').append(bySource[s]);
            sep = ", ";
        }
        if (!" (".equals(sep)) sb.append(')');
        return sb.toString();
    }

    /**
     * Activity-recognition events can arrive late, and a registration may be
     * answered with the last transition seen. Act only on one that happened
     * in the last ACTIVITY_FRESH_MS: an old "entered a vehicle" says nothing
     * about now. Clocks are elapsed-realtime nanoseconds, as the API gives.
     */
    static final long ACTIVITY_FRESH_MS = 3 * 60_000;

    static boolean freshEvent(long eventNanos, long nowNanos) {
        long ageMs = (nowNanos - eventNanos) / 1_000_000L;
        return ageMs >= -60_000 && ageMs <= ACTIVITY_FRESH_MS;
    }
}

package com.roamkeep.app.geofence;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.util.Log;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofenceStatusCodes;
import com.google.android.gms.location.GeofencingEvent;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Broadcast receiver the OS invokes when a registered geofence
 * transitions ENTER or EXIT — even if the Roamkeep process is
 * not running. This is the whole point of this plugin over the
 * JS-callback approach: the OS wakes *us*, we POST directly to
 * Supabase, done.
 *
 * Uses goAsync() to hold the receiver alive while the HTTP request
 * runs on a worker thread. That buys a bounded window (the broadcast
 * timeout), and a chain of 15 s HTTP timeouts on a bad link can outlast
 * it — which is why every check-in is written to the pending queue
 * BEFORE its POST and leaves it only once it has landed: a process
 * killed mid-request loses nothing. The SupabaseRest helper handles one
 * 401 retry via token refresh.
 */
public class GeofenceReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";

    // The drift gate below only distrusts IMPRECISE fixes. A fix at or below
    // this accuracy (error radius, m) is a real GPS fix — trusted even right
    // at a boundary, so a genuine crossing (moving between two nearby zones,
    // ±4 m) is never dropped. Stationary drift shows up as much fuzzier
    // network/low-power fixes (±tens of m), which this leaves gated. Tunable.
    // Package-private so LocationUpdateReceiver can gate breadcrumbs on the
    // same definition of "precise". Two subsystems disagreeing about what
    // counts as a real fix is how this bug happened in the first place.
    static final float DRIFT_MIN_ACC_M = 20f;

    // How long "we are inside, but state says we left" must hold before
    // repairMissedArrival believes it and files an arrival.
    //
    // Sized against what it is distinguishing, not picked for feel. Play
    // Services delivers a real ENTER within its own responsiveness window —
    // tens of seconds to a couple of minutes — while a device whose ENTER was
    // lost waits forever. Three minutes sits clear of the first and costs the
    // second nothing, since by then it has usually been stranded for hours.
    //
    // Without a wait the repair simply won the race on EVERY arrival, because
    // "state says outside" is the ordinary condition while you are travelling
    // somewhere. That is not a divergence to repair.
    private static final long REPAIR_SETTLE_MS = 3 * 60_000;

    // ── Held arrivals ──────────────────────────────────────────────
    //
    // The drift gate below may decline to ANNOUNCE an arrival, but it must
    // not decline for ever. It used to: a gated ENTER set state inside and
    // said nothing, and no path ever came back to it — the repair above only
    // looks at places whose state says OUTSIDE. A car driven into a
    // multi-storey car park (concrete overhead, ±88 m) arrived at the shops
    // in silence, and the family then got "left" with no "arrived".
    //
    // So a gated ENTER is HELD, and a held arrival is resolved by evidence:
    // a precise fix inside it, a precise ENTER, or — when the device was
    // arriving from travel — staying past CONFIRM_DWELL_MS. See judgeHeld.
    // If none of that happens before the EXIT, neither side is announced.

    // "Arriving from travel": the motion model said moving, or an announced
    // EXIT happened, within this long before the ENTER. Long enough to cover
    // queueing into a car park with fixes too fuzzy to register movement;
    // short enough that a phone which has sat still for an evening is never
    // mistaken for one that just got somewhere.
    static final long TRAVEL_WINDOW_MS = 10 * 60_000;

    // How long a held arrival must go without an EXIT before it is believed:
    // since 4.12.1 every arrival, and before that one held from travel. Same
    // scale as REPAIR_SETTLE_MS and the service's STILL_AFTER, for the same
    // reason: it separates a real stop from driving past, and costs a real
    // arrival only a few minutes' delay. A car crosses a 100 m place in
    // seconds and a red light takes a minute or two; walking straight through
    // one takes about two and a half. The arrival is announced with its
    // ORIGINAL time, not the confirmation's. Also the loitering delay of
    // Play Services' DWELL transition (GeofenceArmer.fence), which is one of
    // the confirmations.
    static final long CONFIRM_DWELL_MS = 3 * 60_000;

    // ── Every arrival waits (4.12.1) ───────────────────────────────
    //
    // An ENTER used to be announced at once, so driving through a place sent
    // "arrived" and "left" a minute apart. Now every arrival is HELD, as a
    // drift-gated one already was, and it leaves the hold the same two ways:
    // confirmed once it has lasted CONFIRM_DWELL_MS, and announced for its
    // ENTER's time; or discarded at its EXIT, and then neither side is
    // announced. Departures are not held: "left school" is the alert people
    // wait for, and a "left" is still never sent without its "arrived".
    //
    // A precise fix inside no longer confirms anything by itself, because a
    // car driving through gives exactly those. It turns a drift hold into a
    // dwell hold instead (judgeHeld).
    //
    // What confirms one, since nothing happens at the moment it is due: the
    // breadcrumb batches (confirmHeldArrivals), Play Services' DWELL
    // transition, and the EXIT itself (confirmsAtExit). DWELL is the one that
    // still arrives after an OEM battery manager has killed the service, but
    // it is never the only one: re-registering the fences resets Play
    // Services' view, and a DWELL due across a re-arm never comes.
    //
    // ── Overlapping places (4.12.1) ────────────────────────────────
    //
    // Two places side by side that overlap (neither inside the other) are
    // one place at a time. Where their circles share ground, the arrival
    // that counts is the place pickPlace chooses from a precise fix: the one
    // whose middle is nearer, as a share of its radius. Play Services cannot
    // say this, because it reports crossings, and the shared ground has none
    // that mean anything: a home whose edge runs through its school's yard
    // sent "left Home" and "arrived Home" every few minutes at pickup.
    //
    // So a held arrival at a place with a RIVAL (another place we are inside
    // that overlaps it) is BLOCKED while the evidence says the rival: its
    // dwell does not count, and it cannot be confirmed at its EXIT or by a
    // DWELL. A precise fix that picks it unblocks it, and its dwell starts
    // again from that fix. When it is confirmed, the rival it took over from
    // is HANDED OVER: its departure is announced for the same moment, and it
    // becomes a blocked hold while Play Services still has us inside it, so
    // that its own EXIT, when it comes, announces nothing a second time.
    //
    // With no precise fix there is no evidence, and the place already
    // announced keeps it: a new hold with a rival starts blocked. When a
    // rival's EXIT leaves a hold with none, it is unblocked from that moment
    // (releaseRivals).
    //
    // Nesting is not rivalry. A home inside a town is in both on purpose,
    // and leaving the home must not announce arriving in the town.

    // A DWELL from Play Services is counted from its ENTER, and the ENTER's
    // time here is the triggering fix's. Allow for the two clocks.
    static final long DWELL_EVENT_SLACK_MS = 30_000;

    // Why a held arrival's dwell is not counting.
    static final int BLOCK_NONE = 0;
    static final int BLOCK_RIVAL = 1;   // the evidence says an overlapping place
    static final int BLOCK_AWAY = 2;    // a precise fix outside it, with a rival to go to

    // ── Held departures (4.11.4) ───────────────────────────────────
    //
    // The same lesson from the other side. A gated EXIT used to be dropped,
    // on the belief that "a genuine later departure still announces". It
    // does not: Play Services fires ONE exit per crossing, and once it has
    // fired it believes we are outside, so if the fuzzy one WAS the
    // departure nothing ever sends another. The family got no "left", the
    // member row went on saying they were there, their return was dropped as
    // a duplicate ENTER, and History showed one unbroken stay.
    //
    // So a gated EXIT for a place we are inside is HELD. State still says
    // inside, which is what keeps the drift gate absorbing the follow-up
    // ENTER on a phone parked by a boundary. A held departure leaves the
    // hold one of two ways:
    //   - CONFIRMED by precise fixes outside it by their whole error radius,
    //     holding for EXIT_SETTLE_MS with no fix in between that puts us
    //     back (judgeHeldExit), then announced through settleDeparture with
    //     a time from the hold's evidence (departureTime);
    //   - DISCARDED by Play Services' next ENTER for the place, which says
    //     it was drift and puts Play Services back in step with our state.
    //
    // Not discarded by a precise fix inside. That fix shows only that we
    // have not gone YET: Play Services still has us outside and will not
    // fire again when we do, so the hold is all that is left to announce
    // it. A fix inside restarts the wait and moves the departure time on.

    // How long precise fixes must keep us outside before a held departure is
    // believed. Holds will be made every night on phones parked near an
    // edge, so one confident wrong fix must never be enough. Same scale as
    // REPAIR_SETTLE_MS and CONFIRM_DWELL_MS; the departure itself is dated
    // from the evidence, not from the confirmation.
    static final long EXIT_SETTLE_MS = 3 * 60_000;

    // judgeHeldExit verdicts.
    static final int EXIT_WAIT = 0;      // nothing to change
    static final int EXIT_THERE = 1;     // this fix puts us at the place: stamp it, restart the wait
    static final int EXIT_UNSURE = 2;    // precise, but too near the edge to tell: restart the wait
    static final int EXIT_OUT = 3;       // precise and clearly outside: start the wait
    static final int EXIT_CONFIRM = 4;   // ...and it has held for EXIT_SETTLE_MS

    // ── One POST per check-in at a time ────────────────────────────
    //
    // Ids of check-ins whose POST is under way in this process right now.
    //
    // The queue is WRITE-AHEAD (4.9.0): a check-in is appended before its
    // POST and removed once it lands, so a process killed mid-request loses
    // nothing. The price is that an entry sits in the queue WHILE its own
    // POST is in flight — and three threads drain that queue: the geofence
    // worker, the location worker on every breadcrumb batch, and the app's
    // flush on resume. On the move a batch lands every few seconds, so at
    // nearly every crossing one of them re-sent a row that was already on
    // its way. The primary key made that harmless to the data (the loser
    // got 23505 and was treated as "already there"), but every crossing
    // left a duplicate-key ERROR in the family's Postgres log, cost a second
    // request, and journalled "drain: 1 queued checkin(s) delivered" for a
    // check-in whose first POST had never failed.
    //
    // A POST now claims its id here first, and anyone finding it claimed
    // leaves it alone. In memory on purpose: every sender is in this one
    // process, and if the process dies mid-request the claim dies with it,
    // leaving the queued entry for the next drain — the write-ahead
    // guarantee is untouched.
    private static final Set<String> IN_FLIGHT = ConcurrentHashMap.newKeySet();

    /** Claim a check-in id for sending. False if another thread has it. */
    static boolean claimInFlight(String id) {
        return id != null && IN_FLIGHT.add(id);
    }

    static void releaseInFlight(String id) {
        if (id != null) IN_FLIGHT.remove(id);
    }

    // judgeHeld verdicts.
    static final int HOLD_WAIT = 0;
    static final int HOLD_CONFIRM = 1;        // announce it, for its ENTER's time
    static final int HOLD_DEMOTE = 2;         // a drift hold from travel now needs a precise fix inside
    static final int HOLD_UPGRADE = 3;        // a drift hold, seen inside: now waiting out the dwell
    static final int HOLD_BLOCK_RIVAL = 4;
    static final int HOLD_BLOCK_AWAY = 5;
    static final int HOLD_UNBLOCK = 6;        // its dwell starts again from this fix
    static final int HOLD_RESTART = 7;        // seen outside, no rival: its dwell starts again

    // What a fix says about one held arrival (positionFor).
    static final int POS_NONE = 0;    // not a precise fix: no evidence
    static final int POS_EDGE = 1;    // precise, but too near the edge to tell
    static final int POS_HERE = 2;    // precise, inside by its error, and no rival nearer
    static final int POS_AWAY = 3;    // precise and outside by its error
    static final int POS_RIVAL = 4;   // precise, and an overlapping place is nearer

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null) return;
        // While the member has self-paused, ignore transitions entirely —
        // don't write check-ins and don't re-register dropped fences. The
        // fences are unregistered on pause, but a straggler intent could
        // still arrive; drop it. Same for a device the server has stopped
        // accepting writes from (member removed — see LocationUpdateReceiver).
        PrefsStore gate = new PrefsStore(context.getApplicationContext());
        if (gate.isPaused() || gate.isServerRejected()) return;
        if (event.hasError()) {
            Log.w(TAG, "geofence event error code: " + event.getErrorCode());
            // GEOFENCE_NOT_AVAILABLE (1000): Play Services dropped ALL
            // our fences because location became unavailable (location
            // toggled off, or suspended by deep Doze / battery saver).
            // They do not come back by themselves — until this rebuild
            // they stayed dead until the next app open.
            if (event.getErrorCode() == GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE) {
                PrefsStore prefs = new PrefsStore(context.getApplicationContext());
                prefs.journal("geo: fences dropped by OS (location unavailable) — re-registering");
                BootReceiver.reRegisterGeofences(context.getApplicationContext(), prefs, "geo-recover");
            }
            return;
        }

        // 4.11.1: while the tracking notification cannot be shown, nothing is
        // shared, so a transition is treated as it is during a pause: not
        // written, not even as state. After the error branch above on
        // purpose: re-registering dropped fences is not recording, and
        // skipping it would leave them dead after sharing resumes.
        if (!LocationForegroundService.canDisclose(context)) {
            LocationForegroundService.stopForDisclosure(context, "geofence transition");
            return;
        }

        int transition = event.getGeofenceTransition();
        String type;
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER) {
            type = "arrived";
        } else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            type = "left";
        } else if (transition == Geofence.GEOFENCE_TRANSITION_DWELL) {
            type = "dwell";   // confirms a held arrival; never one by itself (4.12.1)
        } else {
            return;
        }

        List<Geofence> triggered = event.getTriggeringGeofences();
        if (triggered == null || triggered.isEmpty()) return;

        // triggeringLocation.getTime() is epoch-ms stamped by the OS at the
        // actual crossing moment — this is what fixes the "stamped 'now'"
        // bug, because the value survives regardless of when we process
        // the intent. We also pass the lat/lng straight through to the
        // member update below so the live map pin moves at boundary
        // crossings even when the BackgroundGeolocation foreground
        // service has been killed by an aggressive OEM battery saver.
        final Location triggeringLoc = event.getTriggeringLocation();
        final long whenMs = triggeringLoc != null
                ? triggeringLoc.getTime()
                : System.currentTimeMillis();
        final Double tLat = triggeringLoc != null ? triggeringLoc.getLatitude()  : null;
        final Double tLng = triggeringLoc != null ? triggeringLoc.getLongitude() : null;
        // Horizontal accuracy (error radius, m) of the fix that caused the
        // transition — used below to reject drift-induced crossings.
        final Float tAcc = (triggeringLoc != null && triggeringLoc.hasAccuracy())
                ? triggeringLoc.getAccuracy() : null;

        // Capture a snapshot of ids BEFORE goAsync so the lambda doesn't
        // close over a mutable List the receiver framework may recycle.
        final String[] ids = new String[triggered.size()];
        for (int i = 0; i < triggered.size(); i++) ids[i] = triggered.get(i).getRequestId();
        final String finalType = type;

        final PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                handleTransitions(context.getApplicationContext(), ids, finalType, whenMs, tLat, tLng, tAcc);
            } catch (Exception e) {
                Log.w(TAG, "receiver worker failed", e);
            } finally {
                pr.finish();
            }
        }, "RoamkeepGeofenceWorker").start();
    }

    private void handleTransitions(Context ctx, String[] ids, String type, long whenMs,
                                   Double tLat, Double tLng, Float tAcc) {
        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) {
            Log.w(TAG, "no Supabase context — skipping " + ids.length + " events");
            return;
        }

        // A geofence just fired, so the app is alive and not force-stopped.
        // If the location foreground service isn't running (killed while
        // idle), this is a good moment to bring it back so background
        // breadcrumbs resume. Guarded — a background FGS start can be
        // refused on Android 12+, which is harmless here (START_STICKY /
        // next app open will recover it anyway).
        if (!LocationForegroundService.running) {
            try { LocationForegroundService.start(ctx, "geofence"); }
            catch (Exception e) { Log.i(TAG, "geofence kick: FGS start refused (" + e.getMessage() + ")"); }
        }

        SupabaseRest rest = new SupabaseRest(ctx);

        String isoTime = toIso8601Utc(whenMs);
        String memberId    = prefs.getMemberId();

        boolean anyAccepted = false;
        // Places this event sent a spurious EXIT for. Play Services can send
        // one for a whole list of fences at once, mid-drive, for places
        // nowhere near — ten in one burst on a 2026-09-26 test drive — and
        // a line per place buried everything around it while saying nothing
        // about WHY. One summary line per event, with the fix and the power
        // state, which are the evidence for the suspected triggers.
        List<String> spurious = new ArrayList<>();

        for (String placeId : ids) {
            PrefsStore.Place p = prefs.findPlace(placeId);
            if (p == null) {
                Log.w(TAG, "triggered unknown geofence " + placeId + " — possibly stale from a previous session");
                continue;
            }

            // Play Services has had us inside for the dwell: one of the ways
            // a held arrival is confirmed (4.12.1). It changes no state, so
            // it needs none of the gates below.
            if ("dwell".equals(type)) {
                if (confirmOnDwell(prefs, rest, p, System.currentTimeMillis())) {
                    anyAccepted = true;
                    updateMemberAfter(ctx, prefs, rest, memberId, p, "arrived", isoTime, tLat, tLng);
                }
                continue;
            }

            // Anti-drift accuracy gate. Suppress a "crossing" only when the
            // fix is BOTH imprecise (error radius > DRIFT_MIN_ACC_M) AND
            // lands within that error of the boundary — i.e. a fuzzy fix that
            // genuinely can't tell which side you're on. That's GPS drift,
            // not real movement, and it's what spammed arrived/left on
            // stationary phones sitting near a place overnight. A PRECISE
            // fix is always trusted, even right at the edge, so a real
            // crossing between two nearby zones (±4 m) is never dropped — the
            // earlier version wrongly dropped one of those, which then also
            // orphaned its EXIT (state never recorded the ENTER). Radius-
            // independent, so even a small 50 m home stays reliable.
            //
            // IT SUPPRESSES THE ANNOUNCEMENT, NOT THE STATE. Two different
            // questions were being answered by one `continue` here, and
            // conflating them stranded a device. "Is this fix good enough to
            // tell the family about?" is this gate's question. "Where does
            // Play Services think we are?" is what insidePlaceIds is FOR —
            // it exists to pair up Play Services' own event stream, so it has
            // to track what Play Services believes, whatever we decide to say
            // out loud.
            //
            // The failure that forced this: a fuzzy ENTER was dropped, so
            // addInsidePlace never ran, and the device recorded itself
            // OUTSIDE a place it was sitting inside. Play Services only fires
            // on transitions and the phone never crossed the boundary again,
            // so nothing could ever put it back — and the next genuine
            // departure was then discarded as a "spurious EXIT". Dropping an
            // EXIT is recoverable; dropping an ENTER is not, because ENTER is
            // the only event that re-establishes inside-ness.
            //
            // And suppressing the announcement means HOLDING it, not
            // dropping it (4.9.2). An arrival that is never announced while
            // its departure is gives the family "left" with no "arrived" —
            // the exposure this comment used to call known. A gated ENTER is
            // now held until evidence confirms it or its EXIT discards it;
            // see the held-arrival notes at the top of this class.
            if (tLat != null && tLng != null && tAcc != null && tAcc > DRIFT_MIN_ACC_M) {
                float[] d = new float[1];
                Location.distanceBetween(p.lat, p.lng, tLat, tLng, d);
                float distFromEdge = Math.abs(d[0] - p.radius);
                if (distFromEdge < tAcc) {
                    // ENTER records state; EXIT does NOT. The asymmetry is
                    // the same one stated above, and 4.8.8 got it wrong by
                    // treating the two alike.
                    //
                    // Recording a gated ENTER is what stops the stranding:
                    // state says inside, which is where we are, and a later
                    // real EXIT is then accepted.
                    //
                    // Recording a gated EXIT looked symmetrical and was a
                    // regression. It sets state OUTSIDE while the device is
                    // sitting inside — and Play Services, which fired that
                    // EXIT, also believes outside. So the next ordinary
                    // precise fix produces an ENTER that nothing can tell
                    // apart from a real arrival, and it gets announced. A
                    // phone parked near a boundary then wakes the whole keep
                    // with "arrived" all night: exactly the flapping this
                    // gate exists to stop, leaking out one side of it.
                    //
                    // Leaving state alone restores the absorption — the
                    // follow-up ENTER lands on state that already says
                    // inside and is dropped as a duplicate.
                    //
                    // But the EXIT must not simply be dropped either (4.11.4).
                    // This comment used to end "a genuine later departure
                    // still announces", and it does not: Play Services fires
                    // one EXIT per crossing, so a fuzzy one that WAS the
                    // departure is never sent again. It is HELD, with state
                    // unchanged, until fixes settle it; see the held-departure
                    // notes at the top of this class.
                    //
                    // A gated ENTER that newly puts us inside is HELD. One
                    // for a place we were already inside is not: that
                    // arrival was either announced long ago or is already
                    // held, and holding it again would announce it twice. It
                    // does end a held departure, though: Play Services has
                    // us back inside, so that EXIT was drift.
                    String outcome;
                    if ("arrived".equals(type)) {
                        if (prefs.claimInsidePlace(placeId)) {
                            boolean travel = travelAt(prefs, whenMs);
                            int bl = admitArrival(prefs, p, whenMs, travel, false, tLat, tLng,
                                    tAcc == null ? -1f : tAcc);
                            outcome = "held until confirmed ("
                                    + (travel ? "arriving from travel" : "no recent travel")
                                    + rivalNote(bl) + ")";
                        } else {
                            PrefsStore.HeldExit hx = prefs.claimHeldExit(placeId);
                            outcome = hx == null ? "not announced (already inside)"
                                    : "not announced (already inside); the departure held since "
                                      + hhmm(hx.exitMs) + " was drift, discarded";
                        }
                    } else if (prefs.isInsidePlace(placeId)) {
                        prefs.holdExit(placeId, whenMs);
                        outcome = "held until confirmed (state: inside)";
                    } else {
                        outcome = "drift, not announced (not inside)";
                    }
                    prefs.journal("geo: " + type + " " + p.name + " fuzzy fix ±"
                            + Math.round(tAcc) + "m within " + Math.round(distFromEdge)
                            + "m of edge — " + outcome);
                    Log.i(TAG, "drift-gated " + type + " for " + p.name + " (acc " + Math.round(tAcc) + "m)");
                    continue;
                }
            }

            // State-gate the broadcast. Google Play Services fires
            // synthetic EXITs on re-registration, doze wake-up, and
            // some charging-state transitions — these do not
            // correspond to the user actually crossing the boundary.
            // Dropping any EXIT for a place we don't have an unmatched
            // ENTER for eliminates those, at the cost of losing any
            // truly-first EXIT after a fresh install (which has no
            // prior ENTER either, so no activity-log asymmetry).
            // State-gate, and for an arrival claim it in the same step.
            //
            // Flip local state OPTIMISTICALLY — before the DB writes — so a
            // transient network failure can't permanently desync us from the
            // OS's view. If the writes below fail, we lose one check-in row,
            // but the next legitimate transition still gets through (because
            // state matches reality). The earlier "update only on success"
            // version had a real-world failure mode where a flaky network on
            // the EXIT (e.g. WiFi → cellular handoff while leaving home)
            // would leave state stuck at "inside home" forever, silently
            // deduping every future ENTER for that place.
            //
            // The ENTER case tests and sets atomically, because the
            // breadcrumb pipeline now also files arrivals (see
            // repairMissedArrival) from a different thread. A separate
            // isInsidePlace + addInsidePlace would let one homecoming be
            // announced twice.
            //
            // Both branches also resolve a HELD arrival for the place, if
            // there is one — the two transitions are the strongest evidence
            // a hold can get, and each is the last chance to settle it.
            if ("arrived".equals(type)) {
                if (!prefs.claimInsidePlace(placeId)) {
                    // Already inside. A departure held for this place ends
                    // here: Play Services has us back inside, so that EXIT
                    // was drift (4.11.4).
                    PrefsStore.HeldExit hx = prefs.claimHeldExit(placeId);
                    if (hx != null) {
                        prefs.journal("geo: arrived " + p.name + " — already inside; the departure"
                                + " held since " + hhmm(hx.exitMs) + " was drift, discarded");
                    }
                    // If that is because the arrival is held by the drift
                    // gate, this ENTER (one the gate let through, so precise
                    // or clearly on the inside of the edge) says they are
                    // there. Until 4.12.1 that announced it; now it waits out
                    // the dwell like any arrival, because being there is not
                    // staying, and a car driving through is there too.
                    PrefsStore.Held held = prefs.getHeldArrivals().get(placeId);
                    if (held == null || held.dwell) {
                        Log.i(TAG, "duplicate ENTER for " + p.name + " — already inside, skipping");
                        if (hx == null) prefs.journal("geo: duplicate ENTER " + p.name + " dropped");
                        continue;
                    }
                    prefs.reviseHeldArrival(placeId, held.enterMs, held.travel, true, held.blocked);
                    prefs.journal("geo: arrived " + p.name + " — held arrival from "
                            + hhmm(held.enterMs) + " has an unambiguous enter; waiting out the dwell");
                    continue;
                }
            } else {
                // 4.11.1: one atomic step, as the ENTER side has been since
                // 4.8.7. Test-then-remove let two workers handling the same
                // EXIT both find "inside" and both announce a departure.
                if (!prefs.claimExitPlace(placeId)) {
                    Log.i(TAG, "spurious EXIT — not currently inside, skipping");
                    spurious.add(p.name);   // journalled once, after the loop
                    continue;
                }
                // A departure already held for this place (4.11.4): with no
                // ENTER since, Play Services has had us outside from then,
                // so it is dated from the hold's evidence, no later than now.
                long depMs = whenMs;
                String note = "";
                PrefsStore.HeldExit hx = prefs.claimHeldExit(placeId);
                if (hx != null) {
                    depMs = departureTime(hx.exitMs, hx.thereMs, whenMs);
                    note = " — held since " + hhmm(hx.exitMs) + ", announced for " + hhmm(depMs);
                }
                if (!settleDeparture(prefs, rest, p, depMs, note)) continue;
                anyAccepted = true;
                updateMemberAfter(ctx, prefs, rest, memberId, p, "left", isoTime, tLat, tLng);
                continue;
            }
            // An arrival, newly inside. Held for the dwell (4.12.1), not
            // announced: a drive through the place must say nothing. It is
            // announced by whichever confirmation comes first, for this
            // ENTER's time, and discarded by an EXIT that comes first.
            boolean travel = travelAt(prefs, whenMs);
            int bl = admitArrival(prefs, p, whenMs, travel, true, tLat, tLng,
                    tAcc == null ? -1f : tAcc);
            prefs.journal("geo: arrived " + p.name + " — held for " + (CONFIRM_DWELL_MS / 60_000)
                    + "m before it is announced" + rivalNote(bl));
            anyAccepted = true;
            // The avatar should still move.
            updateMemberAfter(ctx, prefs, rest, memberId, p, type, isoTime, tLat, tLng);
        }

        if (!spurious.isEmpty()) {
            prefs.journal(spuriousExitLine(spurious, tAcc, SupabaseRest.powerSource(ctx)));
        }

        // Even if every transition was state-gated away as spurious,
        // the OS still handed us a real location fix. Push it through
        // so the avatar reflects movement at the moment of the
        // (suspected-spurious) crossing rather than going stale.
        if (!anyAccepted && tLat != null && tLng != null) {
            try {
                JSONObject upd = new JSONObject();
                upd.put("lat", tLat);
                upd.put("lng", tLng);
                upd.put("last_seen", isoTime);
                rest.updateMember(memberId, upd);
            } catch (JSONException ignored) {}
        }

        // Drain anything left over from earlier failed deliveries. We
        // know the network was just up enough for the OS to wake us
        // (otherwise this fire wouldn't have happened) so this is a
        // good moment to sweep. If a retry still fails, the entry
        // stays in the queue for the next attempt.
        drainPendingCheckins(prefs, rest);
    }

    /**
     * Mirror the JS path after an announced transition: on arrival set
     * last_place_id, on departure clear it (or move it to another place we
     * are still inside). Also push the triggering lat/lng and last_seen so
     * the live map pin tracks the user, and piggyback the battery level so
     * it stays current in the background between location fires.
     *
     * One request, and until 4.11.4 its result was ignored. The check-in
     * beside it is queued and retried; this was not, so when it failed (a
     * departure from home is exactly the Wi-Fi to cellular handoff) the
     * family saw "left Home" in Activity and "At Home" on the Family tab for
     * as long as the member was out. It is now journalled, and the pin write
     * re-sends last_place_id whenever it differs from what last landed
     * (LocationUpdateReceiver): a delta handler is an optimisation, never
     * the only path.
     */
    private static void updateMemberAfter(Context ctx, PrefsStore prefs, SupabaseRest rest,
                                          String memberId, PrefsStore.Place p, String type,
                                          String isoTime, Double tLat, Double tLng) {
        try {
            JSONObject upd = new JSONObject();
            if (tLat != null && tLng != null) {
                upd.put("lat", tLat);
                upd.put("lng", tLng);
                upd.put("last_seen", isoTime);
            }
            int batt = SupabaseRest.currentBatteryLevel(ctx);
            if (batt >= 0) upd.put("battery", batt);
            // An arrival still held is not where the family has been told
            // they are, so it must not displace what was written (4.12.1).
            boolean announced = "arrived".equals(type)
                    && !prefs.getHeldArrivals().containsKey(p.id);
            String place = lastPlaceNow(prefs, announced ? p.id : prefs.getLastPlaceSent(),
                    tLat, tLng);
            upd.put("last_place_id", place.isEmpty() ? JSONObject.NULL : place);
            if (rest.updateMember(memberId, upd)) {
                prefs.setLastPlaceSent(place);
            } else {
                prefs.journal("geo: member update after " + type + " " + p.name
                        + " failed; the next pin write repairs it");
            }
        } catch (JSONException e) {
            Log.w(TAG, "member update payload build failed", e);
        }
    }

    /**
     * Everything an accepted departure does once its caller has claimed it
     * (claimExitPlace): settle an arrival still held for the place, then
     * announce. Shared by the transition and the held-departure
     * confirmation, so the two cannot drift apart in what they tell the
     * family (4.11.4); the 4.8.5 shape is one rule kept on one path only.
     *
     * An arrival still held at its own departure: either the stay itself
     * proves it (staying past the dwell, which the breadcrumb path would
     * normally have confirmed already), or nothing ever did, and then this
     * departure is not announced either. The family must never get a "left"
     * without its "arrived". Since 4.12.1 that is also a drive through.
     *
     * A blocked hold says nothing at its EXIT: either an overlapping place
     * was where they were, and if this one had been announced its departure
     * went out at the hand-over, or a precise fix had already shown them
     * gone. Either way the EXIT may leave a hold with no rival, which then
     * counts from now (releaseRivals).
     *
     * @param depMs when it happened, which becomes created_at
     * @param note  appended to the journal line; "" for a plain transition
     * @return false if nothing was announced
     */
    static boolean settleDeparture(PrefsStore prefs, SupabaseRest rest, PrefsStore.Place p,
                                   long depMs, String note) {
        boolean announce = true;
        PrefsStore.Held held = prefs.claimHeldArrival(p.id);
        if (held != null) {
            if (held.blocked == BLOCK_RIVAL) {
                prefs.journal("geo: left " + p.name + " — an overlapping place was where they"
                        + " were; nothing to announce");
                announce = false;
            } else if (!confirmsAtExit(held.enterMs, held.travel, held.dwell, held.blocked, depMs)) {
                prefs.journal("geo: left " + p.name + " — its arrival ("
                        + hhmm(held.enterMs) + ") was never confirmed; neither announced");
                announce = false;
            } else {
                announceArrival(prefs, rest, p, held, "confirmed at departure (stayed "
                        + ((depMs - held.enterMs) / 60_000) + "m)");
            }
        }
        if (announce) announceLeft(prefs, rest, p, depMs, note);
        releaseRivals(prefs, p, depMs);
        return announce;
    }

    /**
     * The departure itself, wherever it was decided: an EXIT, a confirmed
     * held departure, or a hand-over to an overlapping place (4.12.1).
     */
    static void announceLeft(PrefsStore prefs, SupabaseRest rest, PrefsStore.Place p,
                             long depMs, String note) {
        // An ANNOUNCED departure — and only that — counts as recent travel
        // for the next place's held arrival. A discarded one must not: at
        // night that is a drift EXIT, and letting it vouch for the next drift
        // ENTER would confirm it on dwell.
        prefs.setLastExitMs(depMs);
        prefs.journal("geo: left " + p.name + note);
        fileCheckin(prefs, rest, p, "left", depMs);
    }

    /**
     * Announce a held arrival this caller has claimed: first the hand-over
     * from any overlapping place the family was told they were at, then the
     * arrival, both for the ENTER's time. Every confirmation goes through
     * here (a breadcrumb batch, Play Services' DWELL, the EXIT), so the
     * hand-over cannot be left off one of them: the 4.8.5 shape is one rule
     * kept on one path only. The caller brings last_place_id up to date.
     */
    static void announceArrival(PrefsStore prefs, SupabaseRest rest, PrefsStore.Place p,
                                PrefsStore.Held h, String how) {
        for (PrefsStore.Place r : rivalsOf(p, prefs.getPlaces(), prefs.getInsidePlaceIds())) {
            // Only one that was announced: claimHandover refuses a held one.
            if (!prefs.claimHandover(r.id, h.enterMs, BLOCK_RIVAL)) continue;
            // A millisecond before the arrival, so every list sorted by time
            // shows the departure first.
            announceLeft(prefs, rest, r, h.enterMs - 1, " — handed over to " + p.name
                    + ", announced for " + hhmm(h.enterMs));
        }
        prefs.journal("geo: arrived " + p.name + " — " + how + ", announced for " + hhmm(h.enterMs));
        fileCheckin(prefs, rest, p, "arrived", h.enterMs);
    }

    /**
     * After an EXIT: a hold that the departed place was blocking, and that
     * now has no rival at all, is where they are from this moment (4.12.1),
     * judged from here on like any arrival. One that still has a rival waits
     * for a precise fix to choose between them.
     */
    static void releaseRivals(PrefsStore prefs, PrefsStore.Place gone, long atMs) {
        List<PrefsStore.Place> places = prefs.getPlaces();
        Set<String> inside = prefs.getInsidePlaceIds();
        for (Map.Entry<String, PrefsStore.Held> e : prefs.getHeldArrivals().entrySet()) {
            PrefsStore.Held h = e.getValue();
            if (h.blocked == BLOCK_NONE) continue;
            PrefsStore.Place q = prefs.findPlace(e.getKey());
            if (q == null || !partiallyOverlap(q, gone)) continue;
            if (!rivalsOf(q, places, inside).isEmpty()) continue;
            prefs.reviseHeldArrival(q.id, atMs, h.travel, true, BLOCK_NONE);
            prefs.journal("geo: " + q.name + " — " + gone.name + " is behind them, so the dwell"
                    + " here counts from " + hhmm(atMs));
        }
    }

    /**
     * Play Services' DWELL for a place: confirm its held arrival if the rules
     * allow (confirmsOnDwellEvent). Never an arrival by itself. True if one
     * was announced; the caller brings last_place_id up to date.
     */
    static boolean confirmOnDwell(PrefsStore prefs, SupabaseRest rest, PrefsStore.Place p,
                                  long nowMs) {
        PrefsStore.Held h = prefs.getHeldArrivals().get(p.id);
        if (h == null) {
            // Already announced, which is usual: a batch got there first. With
            // state saying outside, though, its ENTER never reached us.
            if (!prefs.isInsidePlace(p.id)) {
                prefs.journal("geo: dwell " + p.name + " while state says outside; its enter"
                        + " never reached us");
            }
            return false;
        }
        if (!confirmsOnDwellEvent(h.enterMs, h.travel, h.dwell, h.blocked,
                prefs.hasHeldExit(p.id), nowMs)) {
            return false;
        }
        PrefsStore.Held c = prefs.claimHeldArrival(p.id);
        if (c == null) return false;
        announceArrival(prefs, rest, p, c, "confirmed by Play Services' dwell after "
                + ((nowMs - c.enterMs) / 60_000) + "m");
        return true;
    }

    /**
     * Hold an arrival this caller has just claimed (claimInsidePlace), and
     * block it if an overlapping place is where they are (4.12.1). Every way
     * an arrival begins goes through here: the transition, the drift gate
     * and the missed-arrival repair.
     *
     * With a rival and no precise fix there is no evidence either way, and
     * the place they were already at keeps it.
     *
     * @return why it is blocked, BLOCK_NONE if it is not
     */
    static int admitArrival(PrefsStore prefs, PrefsStore.Place p, long whenMs, boolean travel,
                            boolean dwell, Double lat, Double lng, float acc) {
        List<PrefsStore.Place> rivals = rivalsOf(p, prefs.getPlaces(), prefs.getInsidePlaceIds());
        int bl = rivals.isEmpty() || positionFor(p, rivals, lat, lng, acc) == POS_HERE
                ? BLOCK_NONE : BLOCK_RIVAL;
        prefs.holdArrival(p.id, whenMs, travel, dwell, bl);
        return bl;
    }

    /** For a journal line: "" unless blocked by a rival. */
    private static String rivalNote(int blocked) {
        return blocked == BLOCK_RIVAL ? "; an overlapping place is where they are, so it waits" : "";
    }

    private static boolean travelAt(PrefsStore prefs, long whenMs) {
        PrefsStore.Motion m = prefs.getMotion();
        return isTravel(m.valid, m.movingUntilMs, prefs.getLastExitMs(), whenMs);
    }

    /**
     * File one check-in row: build it, queue it, POST it, and settle the
     * queue entry by the result. Every path that tells the family about an
     * arrival or a departure goes through here — the transition itself, the
     * missed-arrival repair and the held-arrival confirmations — so they
     * cannot drift apart in what they send or how they handle a failure.
     *
     * @param eventMs when it HAPPENED, which becomes created_at. For a held
     *                arrival that is the original ENTER, not the moment it
     *                was confirmed.
     */
    static void fileCheckin(PrefsStore prefs, SupabaseRest rest, PrefsStore.Place p,
                            String type, long eventMs) {
        try {
            // Client-generated UUID makes retries idempotent — duplicate
            // INSERTs hit the primary-key constraint as 409, which the retry
            // path treats as "already there".
            JSONObject ci = new JSONObject();
            final String id = UUID.randomUUID().toString();
            ci.put("id", id);
            ci.put("keep_id", prefs.getKeepId());
            ci.put("member_id", prefs.getMemberId());
            ci.put("member_name", prefs.getMemberName());
            ci.put("member_avatar", prefs.getMemberAvatar());
            ci.put("type", type);
            ci.put("place", p.icon + " " + p.name);
            // v13. `place` is a display string composed here, so it cannot
            // be matched back to a place once one is renamed — place_id is
            // what the per-place mute rule joins on.
            ci.put("place_id", p.id);
            ci.put("created_at", toIso8601Utc(eventMs));

            // WRITE-AHEAD. Queue first, POST second, and only a landed row
            // leaves the queue. Callers flip state before calling this, so
            // if the process died mid-request — memory pressure, or the
            // broadcast deadline passing on a slow link — the check-in used
            // to be lost with nothing to re-send it: never queued, and state
            // already saying the crossing was handled.
            //
            // Claimed BEFORE it becomes visible in the queue, so no drain on
            // another thread can see it there and send it a second time
            // while this POST is still in flight (see IN_FLIGHT).
            claimInFlight(id);
            try {
                prefs.appendPendingCheckin(ci);
                SupabaseRest.Result r = rest.insertCheckin(ci);
                if (r == SupabaseRest.Result.SUCCESS || r == SupabaseRest.Result.DUPLICATE) {
                    prefs.removePendingCheckin(id);
                } else if (r == SupabaseRest.Result.REJECTED) {
                    // The server will never take this payload; keeping it
                    // would only wedge the queue behind it.
                    prefs.removePendingCheckin(id);
                    prefs.journal("geo: " + type + " " + p.name + " refused by server ("
                            + rest.lastSqlState() + ") — dropped");
                } else {
                    // Network blip — most commonly a WiFi → cellular handoff
                    // at the boundary. It is already queued; the next
                    // breadcrumb fire (seconds away on the move), geofence
                    // fire, or app launch will retry it.
                    prefs.journal("geo: " + type + " " + p.name + " POST failed — queued");
                    // No place name in logcat (4.11.1): the journal line above
                    // says which, and the journal is ours to age out.
                    Log.w(TAG, "checkin insert failed — queued for retry (pending="
                            + prefs.pendingCount() + ")");
                }
            } finally {
                releaseInFlight(id);
            }
        } catch (JSONException e) {
            Log.w(TAG, "checkin payload build failed", e);
        }
    }

    /** Iterate the pending-checkin queue, retry each entry, drop on
     *  success, duplicate (already there) or a permanent rejection, and skip
     *  any another thread is sending right now. Static so the
     *  NativeGeofencePlugin's flushPending() entrypoint can reuse it without
     *  instantiating a receiver.
     *
     *  @return how many were DELIVERED by this drain — not ones found
     *          already on the server, which are journalled separately. */
    static int drainPendingCheckins(PrefsStore prefs, SupabaseRest rest) {
        List<JSONObject> pending = prefs.getPendingCheckins();
        if (pending.isEmpty()) return 0;
        int drained = 0, alreadyThere = 0, dropped = 0, busy = 0;
        String droppedWhy = null;
        for (JSONObject entry : pending) {
            String id = entry.optString("id", null);
            if (id == null) {
                // Pre-UUID payload from an older build: drop, can't
                // safely retry without idempotency.
                continue;
            }
            // Another thread is sending this one right now — usually the
            // crossing's own first POST, which is why it is in the queue at
            // all. Leave it; if that POST fails, it stays queued for the
            // next drain.
            if (!claimInFlight(id)) { busy++; continue; }
            SupabaseRest.Result r;
            try {
                // 4.11.1: this drain works from a snapshot, and another sender
                // may have delivered and removed the row since it was taken.
                // Holding the claim, ask the queue itself before sending.
                if (!prefs.isPendingCheckin(id)) continue;
                r = rest.insertCheckin(entry);
                // ...and settle it BEFORE the claim is released, as
                // fileCheckin does. Releasing first left a moment in which a
                // second drain could claim the row and POST it again.
                if (r == SupabaseRest.Result.SUCCESS
                        || r == SupabaseRest.Result.DUPLICATE
                        || r == SupabaseRest.Result.REJECTED) {
                    prefs.removePendingCheckin(id);
                }
            } finally {
                releaseInFlight(id);
            }
            if (r == SupabaseRest.Result.SUCCESS) {
                drained++;
            } else if (r == SupabaseRest.Result.DUPLICATE) {
                // Already there: an earlier POST landed but its response
                // never came back. Cleared, but NOT counted as delivered —
                // that count used to include these, which is how a
                // double-send passed for a successful retry in the journal.
                alreadyThere++;
            } else if (r == SupabaseRest.Result.REJECTED) {
                // The server refused this payload and always will. It used
                // to stop the drain like a network failure, so one such
                // entry at the head held every later check-in back until 50
                // newer ones pushed it out of the queue.
                dropped++;
                droppedWhy = rest.lastSqlState();
            } else {
                // Stop on first transient failure — the network is still
                // down (or our token can't refresh). Try again next
                // fire. Avoids burning 50 POSTs against a dead link.
                Log.w(TAG, "drain stalled at " + id + "; "
                        + (pending.size() - drained - alreadyThere - dropped) + " still pending");
                break;
            }
        }
        if (drained > 0) {
            Log.i(TAG, "drained " + drained + " pending checkin(s)");
        }
        if (busy > 0) {
            Log.i(TAG, "drain skipped " + busy + " check-in(s) already being sent");
        }
        if (alreadyThere > 0) {
            // Rare now, and worth seeing: each one is a POST whose row landed
            // while its response was lost.
            prefs.journal("drain: " + alreadyThere + " check-in(s) were already on the server"
                    + " (a response had been lost) — cleared");
        }
        if (dropped > 0) {
            // Say how many: a drop is otherwise invisible, and the journal
            // is the only witness this path has.
            prefs.journal("drain: dropped " + dropped + " check-in(s) the server refused (" + droppedWhy + ")");
        }
        return drained;
    }

    /**
     * File an arrival we should have had, when the position says we are
     * inside a place our own state thinks we left.
     *
     * WHY THIS EXISTS. Every other path here is a delta handler: it reacts to
     * a transition Play Services reports. The codebase's standing rule is that
     * a delta handler is an optimisation and never the only path, because the
     * one event you miss is the one nothing comes back for. Geofencing is the
     * sharpest case of that — transitions fire only on a CROSSING, so an ENTER
     * that is lost, dropped or never delivered can never be re-sent while the
     * phone sits still inside the place. The device is then stranded: no
     * arrival is ever filed, the timeline keeps a departure with no return,
     * and the next genuine departure is discarded as spurious. Until now the
     * only repair was somebody opening the app.
     *
     * So this reconciles against the authoritative answer — where the device
     * actually is — rather than waiting for another delta.
     *
     * DELIBERATELY ENTER-ONLY. The missing-EXIT direction heals itself: the
     * moment the person really leaves, Play Services fires again and the
     * normal path handles it. Only the ENTER direction is unrecoverable by
     * construction, so only the ENTER direction is repaired here. Symmetry
     * would cost blast radius and buy nothing.
     *
     * The conditions are strict so that drift can never trigger it: the fix
     * must be PRECISE (the same bar GeofenceReceiver uses to trust a crossing
     * at all), and we must be inside by a clear margin — its whole error
     * radius clear of the boundary, not merely inside it. A fuzzy fix, or one
     * hovering near the edge, is exactly what we refuse to act on everywhere
     * else, and acting on it here would manufacture the arrivals the drift
     * gate above exists to suppress.
     *
     * And the divergence must PERSIST — see REPAIR_SETTLE_MS. Being inside a
     * place that state says you left is the ordinary condition on the way to
     * arriving anywhere; only its failure to resolve marks a missed crossing.
     * Acting immediately made this the primary arrival path rather than the
     * backstop it is, beating the geofence to every homecoming.
     *
     * Self-limiting: it fires only while state disagrees with position, and
     * its first action makes them agree. A real ENTER arriving afterwards is
     * absorbed by the duplicate-ENTER guard.
     */
    static void repairMissedArrival(PrefsStore prefs, SupabaseRest rest,
                                    double lat, double lng, float acc, long whenMs) {
        if (acc < 0 || acc > DRIFT_MIN_ACC_M) return;   // not precise enough to act on
        List<PrefsStore.Place> places = prefs.getPlaces();
        if (places == null || places.isEmpty()) return;

        String keepId   = prefs.getKeepId();
        String memberId = prefs.getMemberId();
        if (keepId == null || memberId == null) return;

        JSONObject watch = prefs.getRepairWatch();
        boolean watchChanged = false;

        float[] d = new float[1];
        for (PrefsStore.Place p : places) {
            boolean diverged = !prefs.isInsidePlace(p.id);
            if (diverged) {
                Location.distanceBetween(lat, lng, p.lat, p.lng, d);
                // Inside by a clear margin — the entire error radius within
                // the boundary, so no plausible reading of this fix puts us
                // outside.
                diverged = d[0] < p.radius - acc;
            }
            if (!diverged) {
                // Agrees, or too close to the edge to tell. Either way this
                // is not the condition we are waiting on; forget the clock.
                if (watch.has(p.id)) { watch.remove(p.id); watchChanged = true; }
                continue;
            }

            // Inside, while state says we left. WAIT before acting on it.
            //
            // This is a backstop for a crossing that is never coming, not a
            // competitor to Play Services. Without the wait it fired on every
            // ordinary arrival, because "state says outside" is simply what
            // state says while you are on your way somewhere — and it beat
            // the geofence by seconds, so each homecoming produced a
            // "recovered from position" line followed by a dropped duplicate.
            // That is a journal crying wolf on the one instrument used to
            // diagnose everything else, and it also manufactured arrived/left
            // pairs for places merely passed through.
            //
            // Waiting separates the two cases by the only thing that actually
            // distinguishes them: a real arrival gets its ENTER within the
            // geofence's own responsiveness window, and a stranded device
            // never does. A device that has been stranded for hours can
            // certainly wait REPAIR_SETTLE_MS more.
            long since = watch.optLong(p.id, 0L);
            if (since <= 0L || since > whenMs) {
                // Also resets a stamp that is in the FUTURE: a clock change
                // or a fix with a bad timestamp would otherwise park the wait
                // beyond any elapsed time and disable the repair silently.
                try {
                    watch.put(p.id, whenMs);
                    watchChanged = true;
                } catch (JSONException e) {
                    Log.w(TAG, "repair watch update failed", e);
                }
                continue;                      // start the clock, act later
            }
            if (whenMs - since < REPAIR_SETTLE_MS) continue;

            // Claim it atomically. This runs on the location worker thread
            // while a real ENTER may be landing on the geofence worker, and a
            // check-then-act across those two would file the arrival twice.
            // Whoever loses the claim says nothing.
            //
            // The claim also flips state BEFORE the POST, matching the
            // optimistic ordering the transition path uses: a failed POST
            // costs a row, but never leaves state disagreeing with position,
            // which is the condition this function exists to end.
            watch.remove(p.id);
            watchChanged = true;
            if (!prefs.claimInsidePlace(p.id)) continue;
            // Held like every arrival (4.12.1), from the first fix that
            // showed it, so the dwell it has just waited out counts.
            // confirmHeldArrivals runs straight after this, on the same fix,
            // and announces it unless an overlapping place is where they are.
            int bl = admitArrival(prefs, p, since, travelAt(prefs, since), true, lat, lng, acc);
            prefs.journal("geo: arrived " + p.name + " — recovered from position (no"
                    + " geofence enter in " + ((whenMs - since) / 60_000) + "m)" + rivalNote(bl));
            Log.i(TAG, "repaired missed ENTER for " + p.name
                    + " (±" + Math.round(acc) + "m, " + Math.round(d[0]) + "m from centre)");
        }
        if (watchChanged) prefs.setRepairWatch(watch);
    }

    /**
     * Settle held arrivals against a fresh position — the breadcrumb
     * pipeline's half of the held-arrival rules (the transitions settle the
     * rest, in handleTransitions).
     *
     * Runs on every location batch, which keeps arriving while the device is
     * parked, so a held arrival is normally announced within a batch or two
     * of CONFIRM_DWELL_MS rather than at its departure. It is also where the
     * evidence between overlapping places is weighed (4.12.1): each batch can
     * block a hold or start its dwell again.
     *
     * @param lat,lng,acc the batch's most PRECISE fix, as for
     *                    repairMissedArrival — the position rules rest on
     *                    trusting the reading
     * @param nowMs       the batch's NEWEST fix time, for the dwell rule
     */
    static void confirmHeldArrivals(PrefsStore prefs, SupabaseRest rest,
                                    double lat, double lng, float acc, long nowMs) {
        Map<String, PrefsStore.Held> held = prefs.getHeldArrivals();
        if (held.isEmpty()) return;
        String memberId = prefs.getMemberId();
        if (prefs.getKeepId() == null || memberId == null) return;

        List<PrefsStore.Place> places = prefs.getPlaces();
        Set<String> inside = prefs.getInsidePlaceIds();
        for (Map.Entry<String, PrefsStore.Held> e : held.entrySet()) {
            String id = e.getKey();
            PrefsStore.Held h = e.getValue();
            PrefsStore.Place p = prefs.findPlace(id);
            if (p == null) {
                // removePlace drops a place's hold with it; this covers
                // anything that slipped past. A deleted place is never
                // announced.
                if (prefs.claimHeldArrival(id) != null) {
                    prefs.journal("geo: held arrival dropped — its place no longer exists");
                }
                continue;
            }
            List<PrefsStore.Place> rivals = rivalsOf(p, places, inside);
            int pos = positionFor(p, rivals, lat, lng, acc);
            int verdict = judgeHeld(h.enterMs, h.travel, h.dwell, h.blocked, !rivals.isEmpty(),
                    nowMs, pos);
            // "Without an EXIT" includes one that is held (4.11.4): Play
            // Services has said we left, and until that is settled the stay
            // is not proven. settleDeparture applies the dwell instead, up to
            // the departure, if it is confirmed.
            if (verdict == HOLD_CONFIRM && prefs.hasHeldExit(id)) verdict = HOLD_WAIT;
            if (verdict == HOLD_WAIT) continue;
            String fix = "precise fix ±" + Math.round(acc) + "m";
            if (verdict == HOLD_DEMOTE) {
                prefs.demoteHeldArrival(id);
                prefs.journal("geo: held arrival at " + p.name + " — " + fix
                        + " outside it; now needs a precise fix inside");
                continue;
            }
            if (verdict == HOLD_UPGRADE) {
                prefs.reviseHeldArrival(id, h.enterMs, h.travel, true, BLOCK_NONE);
                prefs.journal("geo: held arrival at " + p.name + " — " + fix
                        + " inside it; waiting out the dwell from " + hhmm(h.enterMs));
                continue;
            }
            if (verdict == HOLD_BLOCK_RIVAL || verdict == HOLD_BLOCK_AWAY) {
                boolean rival = verdict == HOLD_BLOCK_RIVAL;
                prefs.reviseHeldArrival(id, h.enterMs, h.travel, h.dwell,
                        rival ? BLOCK_RIVAL : BLOCK_AWAY);
                prefs.journal("geo: held arrival at " + p.name + " — " + fix
                        + (rival ? " nearer an overlapping place" : " outside it")
                        + "; its dwell stops until a fix puts them here");
                continue;
            }
            if (verdict == HOLD_UNBLOCK) {
                prefs.reviseHeldArrival(id, nowMs, h.travel, true, BLOCK_NONE);
                prefs.journal("geo: held arrival at " + p.name + " — " + fix
                        + " puts them here; the dwell counts from " + hhmm(nowMs));
                continue;
            }
            if (verdict == HOLD_RESTART) {
                // Not journalled: driving away before the EXIT lands does
                // this on every batch. The line that settles the hold says
                // the time it was announced for.
                prefs.reviseHeldArrival(id, nowMs, h.travel, true, BLOCK_NONE);
                continue;
            }
            // HOLD_CONFIRM. Claim before acting: the geofence worker may be
            // settling this same hold at an EXIT right now, and only one of
            // us may speak.
            PrefsStore.Held c = prefs.claimHeldArrival(id);
            if (c == null) continue;
            announceArrival(prefs, rest, p, c, "held arrival confirmed after "
                    + ((nowMs - c.enterMs) / 60_000) + "m with no exit");
            writeLastPlace(prefs, rest, memberId, p.id, lat, lng);
        }
    }

    /**
     * What one fix says about a held arrival at p (4.12.1). Pure.
     *
     * Only a PRECISE fix (the drift gate's own bar) is evidence. Outside by
     * its whole error radius is AWAY. With rivals (overlapping places we are
     * also inside), pickPlace decides between them, so a fix in the shared
     * ground says the place whose middle is nearer. Without, inside by the
     * whole error radius is HERE and anything nearer the edge says nothing.
     *
     * @param rivals rivalsOf(p, ...)
     * @param accM   negative means unknown, which is not precise
     */
    static int positionFor(PrefsStore.Place p, List<PrefsStore.Place> rivals,
                           Double lat, Double lng, float accM) {
        if (lat == null || lng == null || accM < 0 || accM > DRIFT_MIN_ACC_M) return POS_NONE;
        double d = metresBetween(lat, lng, p.lat, p.lng);
        if (d > p.radius + accM) return POS_AWAY;
        if (!rivals.isEmpty()) {
            List<PrefsStore.Place> here = new ArrayList<>(rivals);
            here.add(p);
            return pickPlace(here, lat, lng) == p ? POS_HERE : POS_RIVAL;
        }
        return d < p.radius - accM ? POS_HERE : POS_EDGE;
    }

    /**
     * The places we are inside (Play Services' view) that overlap p without
     * either containing the other: the ones it is one place at a time with
     * (4.12.1). Pure.
     */
    static List<PrefsStore.Place> rivalsOf(PrefsStore.Place p, List<PrefsStore.Place> places,
                                           Set<String> inside) {
        List<PrefsStore.Place> out = new ArrayList<>();
        for (PrefsStore.Place q : places) {
            if (q.id.equals(p.id) || !inside.contains(q.id)) continue;
            if (partiallyOverlap(p, q)) out.add(q);
        }
        return out;
    }

    /**
     * True when the two circles share ground and neither lies wholly inside
     * the other, which is nesting (enclosesAnother uses the same edge).
     */
    static boolean partiallyOverlap(PrefsStore.Place a, PrefsStore.Place b) {
        double d = metresBetween(a.lat, a.lng, b.lat, b.lng);
        return d < a.radius + b.radius
                && d + Math.min(a.radius, b.radius) > Math.max(a.radius, b.radius);
    }

    /**
     * What a fix says about one held arrival, given positionFor's answer.
     * Pure, so the rules can be tested without a device.
     *
     * A BLOCKED hold (4.12.1) waits for a fix that puts them HERE, and then
     * its dwell starts again from that fix, or for its rivals' EXITs
     * (releaseRivals). A rival's fix blocks it.
     *
     * A DWELL hold, every arrival since 4.12.1, is confirmed once it has gone
     * CONFIRM_DWELL_MS without an EXIT. A fix inside does not confirm it
     * sooner: a car driving through gives those. A fix outside starts its
     * dwell again (RESTART), so a car that has driven on is not announced
     * while its EXIT is late, and a person who has gone indoors, where no
     * fix is precise, still is, three minutes on. With a rival to be at
     * instead, a fix outside blocks it: time alone would announce the place
     * they have left while they are at the other one.
     *
     * A DRIFT hold (4.9.2), made when the ENTER's fix was too fuzzy to trust:
     *   - a fix HERE says the ENTER was real, and it becomes a dwell hold,
     *     dated from that ENTER, so it is confirmed at once if the dwell has
     *     passed (UPGRADE, or CONFIRM);
     *   - a fix AWAY demotes a hold from travel to one that needs a fix HERE.
     *     Its departure may simply not have fired yet, and the time rule
     *     must not announce a place we have visibly left. State is left
     *     alone: it tracks Play Services;
     *   - otherwise a hold from travel that has gone CONFIRM_DWELL_MS without
     *     an EXIT is a stop, not a drive-past, and is CONFIRMED. One NOT from
     *     travel never confirms on time: that is a phone sitting still near a
     *     boundary, the case the drift gate exists for. Play Services can
     *     believe "inside" on drift for hours.
     */
    static int judgeHeld(long enterMs, boolean travel, boolean dwell, int blocked,
                         boolean hasRivals, long nowMs, int pos) {
        if (blocked != BLOCK_NONE) return pos == POS_HERE ? HOLD_UNBLOCK : HOLD_WAIT;
        if (pos == POS_RIVAL) return HOLD_BLOCK_RIVAL;
        boolean due = nowMs - enterMs >= CONFIRM_DWELL_MS;
        if (dwell) {
            if (pos == POS_AWAY) return hasRivals ? HOLD_BLOCK_AWAY : HOLD_RESTART;
            return due ? HOLD_CONFIRM : HOLD_WAIT;
        }
        if (pos == POS_HERE) return due ? HOLD_CONFIRM : HOLD_UPGRADE;
        if (pos == POS_AWAY) return travel ? HOLD_DEMOTE : HOLD_WAIT;
        return travel && due ? HOLD_CONFIRM : HOLD_WAIT;
    }

    /**
     * Was the device arriving from travel when this ENTER happened? Either
     * the persisted motion model said moving, or an announced departure was
     * filed, within TRAVEL_WINDOW_MS of it.
     *
     * An unknown motion state (fresh install, sign-out) does NOT count. The
     * breadcrumb path assumes moving when it doesn't know, because there a
     * wrong guess costs a few extra points; here it would cost a false
     * arrival, and the rules that remain — a precise fix, or the EXIT — are
     * enough for a genuine one.
     *
     * Both stamps are bounded on the late side too: a stamp far in the
     * future (a clock change, a fix with a bad time) would otherwise vouch
     * for every ENTER until the clock caught up.
     */
    static boolean isTravel(boolean motionValid, long movingUntilMs, long lastExitMs, long enterMs) {
        long from = enterMs - TRAVEL_WINDOW_MS;
        long to   = enterMs + TRAVEL_WINDOW_MS;
        if (motionValid && movingUntilMs >= from && movingUntilMs <= to) return true;
        return lastExitMs > 0 && lastExitMs >= from && lastExitMs <= to;
    }

    /**
     * An arrival still held when its EXIT comes: does the stay itself prove
     * it? Only if it lasted the dwell, unblocked, and for a drift hold only
     * from travel: the same condition the breadcrumb path confirms on,
     * applied as a backstop for a device that produced no batch in between.
     * Anything else was a drive past, drift, or a stay at an overlapping
     * place, and neither side is announced.
     */
    static boolean confirmsAtExit(long enterMs, boolean travel, boolean dwell, int blocked,
                                  long exitMs) {
        return blocked == BLOCK_NONE && (dwell || travel) && exitMs - enterMs >= CONFIRM_DWELL_MS;
    }

    /**
     * Play Services' DWELL for a place with a held arrival: Play Services
     * saying it has had us inside since its ENTER, for the dwell. That is
     * the time rule, so the same holds are confirmed by it as by time
     * (judgeHeld), never a blocked one, a drift hold not from travel, or one
     * whose departure is held. Counted from the hold's own time, because an
     * unblocked hold's dwell restarted after Play Services' began.
     */
    static boolean confirmsOnDwellEvent(long enterMs, boolean travel, boolean dwell, int blocked,
                                        boolean exitHeld, long nowMs) {
        return blocked == BLOCK_NONE && !exitHeld && (dwell || travel)
                && nowMs - enterMs >= CONFIRM_DWELL_MS - DWELL_EVENT_SLACK_MS;
    }

    /**
     * Settle held departures against a fresh position: the breadcrumb
     * pipeline's half of the held-departure rules (an ENTER settles the
     * rest, in handleTransitions). See judgeHeldExit.
     *
     * @param lat,lng,acc the batch's most PRECISE fix, as for the held
     *                    arrivals; acc negative when none has an accuracy
     * @param fixMs       that fix's own time: the wait and the departure
     *                    time are both about when the fixes were taken
     */
    static void confirmHeldExits(PrefsStore prefs, SupabaseRest rest,
                                 double lat, double lng, float acc, long fixMs) {
        Map<String, PrefsStore.HeldExit> held = prefs.getHeldExits();
        if (held.isEmpty()) return;
        String memberId = prefs.getMemberId();
        if (prefs.getKeepId() == null || memberId == null) return;

        float[] d = new float[1];
        for (Map.Entry<String, PrefsStore.HeldExit> e : held.entrySet()) {
            String id = e.getKey();
            PrefsStore.HeldExit h = e.getValue();
            PrefsStore.Place p = prefs.findPlace(id);
            if (p == null) {
                if (prefs.claimHeldExit(id) != null) {
                    prefs.journal("geo: held departure dropped — its place no longer exists");
                }
                continue;
            }
            Location.distanceBetween(lat, lng, p.lat, p.lng, d);
            int verdict = judgeHeldExit(h.exitMs, h.outSinceMs, fixMs, d[0], p.radius, acc);
            if (verdict == EXIT_WAIT) continue;
            if (verdict == EXIT_THERE) {
                if (h.outSinceMs != 0L || h.thereMs < fixMs) {
                    prefs.touchHeldExit(id, 0L, Math.max(h.thereMs, fixMs));
                }
                continue;
            }
            if (verdict == EXIT_UNSURE) {
                if (h.outSinceMs != 0L) prefs.touchHeldExit(id, 0L, h.thereMs);
                continue;
            }
            if (verdict == EXIT_OUT) {
                prefs.touchHeldExit(id, fixMs, h.thereMs);
                continue;
            }
            // EXIT_CONFIRM. Claim it before acting: an ENTER on the geofence
            // worker may be discarding this same hold right now.
            PrefsStore.HeldExit c = prefs.claimHeldExit(id);
            if (c == null) continue;
            // And flip state as an accepted EXIT does. A hold exists only
            // while state says inside; losing this claim means another path
            // has already settled the place, and it is not ours to announce.
            if (!prefs.claimExitPlace(id)) continue;
            long depMs = departureTime(c.exitMs, c.thereMs, c.outSinceMs);
            boolean announced = settleDeparture(prefs, rest, p, depMs,
                    " — held departure confirmed by precise fixes outside for "
                    + ((fixMs - c.outSinceMs) / 60_000) + "m (±" + Math.round(acc) + "m, "
                    + Math.round(d[0] - p.radius) + "m out), announced for " + hhmm(depMs));
            if (announced) writeLastPlace(prefs, rest, memberId, prefs.getLastPlaceSent(), lat, lng);
        }
    }

    /**
     * What a fresh fix says about one held departure. Pure, so the rules can
     * be tested without a device (HeldDepartureTest).
     *
     *   - A fix taken before the EXIT says nothing about it: WAIT.
     *   - PRECISE (the drift gate's own bar) and outside by its whole error
     *     radius: the first starts the wait (OUT), and one at least
     *     EXIT_SETTLE_MS later CONFIRMS. A single confident fix never does:
     *     holds are made nightly by phones parked near an edge.
     *   - Centre inside the place, at any accuracy: we cannot rule out still
     *     being there, so THERE (restart the wait, and the departure, when
     *     it comes, is no earlier than this fix). Not a discard; see the
     *     held-departure notes at the top of this class.
     *   - Precise, but within its error of the edge: UNSURE, restart the wait.
     *   - Imprecise and outside: proves nothing either way, WAIT.
     *
     * @param outSinceMs the running wait's start, 0 for none. One in the
     *                   future (a clock change) restarts it, as the repair
     *                   watch does, rather than parking it beyond reach.
     * @param accM       negative means unknown, which is not precise.
     */
    static int judgeHeldExit(long exitMs, long outSinceMs, long fixMs,
                             float distM, float radiusM, float accM) {
        if (fixMs < exitMs) return EXIT_WAIT;
        boolean precise = accM >= 0 && accM <= DRIFT_MIN_ACC_M;
        if (precise && distM > radiusM + accM) {
            if (outSinceMs <= 0L || outSinceMs > fixMs) return EXIT_OUT;
            return fixMs - outSinceMs >= EXIT_SETTLE_MS ? EXIT_CONFIRM : EXIT_WAIT;
        }
        if (distM <= radiusM) return EXIT_THERE;
        return precise ? EXIT_UNSURE : EXIT_WAIT;
    }

    /**
     * When a held departure happened: the last we knew of the member there
     * (the EXIT itself, or a later fix that still put them there), but never
     * after the first fix that proved them gone.
     *
     * Unless that knowledge is old. A hold can sit for hours on a phone with
     * no fixes worth the name, and then a morning departure would be filed
     * at 03:12, the time of a drift EXIT in the night. When the last we knew
     * is more than TRAVEL_WINDOW_MS before the proof, we know when they were
     * gone and not when they went, and the proof's own time is the honest
     * answer.
     *
     * @param outMs the first fix (or EXIT) that proved them outside; 0 none
     */
    static long departureTime(long exitMs, long thereMs, long outMs) {
        long last = Math.max(exitMs, thereMs);
        if (outMs <= 0L) return last;
        if (last >= outMs) return outMs;
        return outMs - last > TRAVEL_WINDOW_MS ? outMs : last;
    }

    /**
     * The place the family has been told this member is at, which is what
     * keep_members.last_place_id should say: one the inside-set holds whose
     * arrival was announced, not held. `prefer` when it qualifies, so a value
     * already written is kept rather than swapped for another place we are
     * also inside; otherwise pickPlace's answer. Null for none.
     *
     * A place with no metadata here is skipped: it is not one of ours any
     * more, and last_place_id is a foreign key that would refuse it.
     *
     * A held DEPARTURE still counts as there: the family has not been told
     * "left", and the row moves with the announcement, not before it. Pure,
     * for LastPlaceTest.
     */
    static String placeToShow(Set<String> inside, Set<String> heldArrivals,
                              List<PrefsStore.Place> places, String prefer,
                              Double lat, Double lng) {
        List<PrefsStore.Place> here = new ArrayList<>();
        for (PrefsStore.Place p : places) {
            if (!inside.contains(p.id) || heldArrivals.contains(p.id)) continue;
            if (p.id.equals(prefer)) return p.id;
            here.add(p);
        }
        PrefsStore.Place best = pickPlace(here, lat, lng);
        return best == null ? null : best.id;
    }

    /**
     * Which of several places someone inside all of them is at (4.12.1). The
     * app's pickPlace is the same rule; the two must agree, because this one
     * writes last_place_id and that one reads positions without it.
     *
     * 1. A place that wholly contains another candidate gives way to it: a
     *    home inside a town says home, wherever in the home they stand.
     * 2. Of the rest, the one whose centre is nearest as a share of its
     *    radius: a home and a school side by side, overlapping, say whichever
     *    middle they are nearer. "Smallest" got that case wrong whenever the
     *    two differed in size, and said nothing at all when they did not.
     * 3. No position, or a tie: the smaller place, then the lower id, so every
     *    caller agrees.
     *
     * Rule 2 alone gets nesting wrong: at the edge of a home whose town's
     * centre happens to be close by, the town's share is the smaller.
     */
    static PrefsStore.Place pickPlace(List<PrefsStore.Place> here, Double lat, Double lng) {
        final boolean located = lat != null && lng != null;
        PrefsStore.Place best = null;
        double bestShare = 0;
        for (PrefsStore.Place p : here) {
            if (enclosesAnother(p, here)) continue;
            double share = located ? metresBetween(lat, lng, p.lat, p.lng) / p.radius : 0;
            if (best == null || share < bestShare
                    || (share == bestShare && (p.radius < best.radius
                        || (p.radius == best.radius && p.id.compareTo(best.id) < 0)))) {
                best = p;
                bestShare = share;
            }
        }
        return best;
    }

    /** True when another, smaller place in the list lies wholly inside p. */
    static boolean enclosesAnother(PrefsStore.Place p, List<PrefsStore.Place> here) {
        for (PrefsStore.Place q : here) {
            if (q == p || q.radius >= p.radius) continue;
            if (metresBetween(p.lat, p.lng, q.lat, q.lng) + q.radius <= p.radius) return true;
        }
        return false;
    }

    /**
     * Great-circle distance in metres. Location.distanceBetween is an Android
     * stub under plain JUnit, and a ranking needs nothing finer than this.
     */
    static double metresBetween(double lat1, double lng1, double lat2, double lng2) {
        double dLat = Math.toRadians(lat2 - lat1), dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
    }

    /** placeToShow from this device's state, "" for none. lat/lng may be null. */
    static String lastPlaceNow(PrefsStore prefs, String prefer, Double lat, Double lng) {
        String id = placeToShow(prefs.getInsidePlaceIds(), prefs.getHeldArrivals().keySet(),
                prefs.getPlaces(), prefer, lat, lng);
        return id == null ? "" : id;
    }

    /**
     * Bring last_place_id up to date after an announcement made away from a
     * transition: a repaired or confirmed arrival, a confirmed departure.
     * A failure is left to the pin write, which re-sends whatever differs
     * from what last landed.
     */
    private static void writeLastPlace(PrefsStore prefs, SupabaseRest rest, String memberId,
                                       String prefer, double lat, double lng) {
        String place = lastPlaceNow(prefs, prefer, lat, lng);
        try {
            JSONObject upd = new JSONObject();
            upd.put("last_place_id", place.isEmpty() ? JSONObject.NULL : place);
            if (rest.updateMember(memberId, upd)) {
                prefs.setLastPlaceSent(place);
            } else {
                prefs.journal("geo: last_place_id update failed; the next pin write repairs it");
            }
        } catch (JSONException e) {
            Log.w(TAG, "last_place_id payload build failed", e);
        }
    }

    // Most place names a spurious-EXIT line lists before "+N more".
    static final int SPURIOUS_NAMES_MAX = 5;

    /**
     * One journal line for every spurious EXIT a single event carried.
     * Pure, so its format is pinned by a test.
     *
     * A single one keeps the old wording, so the journal reads the same in
     * the ordinary case. Either way the line ends with the triggering fix's
     * accuracy and the power source. Those are the two things that could tell
     * the suspected causes apart: a location source that just changed (a
     * tunnel, a GPS dropout — often a fuzzy or absent fix) versus a
     * charging-state change.
     *
     * @param acc   the triggering fix's accuracy, m; null if the event had
     *              no fix or no accuracy
     * @param power SupabaseRest.powerSource's label, or null if unknown
     */
    static String spuriousExitLine(List<String> names, Float acc, String power) {
        int n = names.size();
        StringBuilder sb = new StringBuilder("geo: ");
        if (n == 1) {
            sb.append("spurious EXIT ").append(names.get(0)).append(" dropped");
        } else {
            sb.append(n).append(" spurious EXITs dropped (");
            int shown = Math.min(n, SPURIOUS_NAMES_MAX);
            for (int i = 0; i < shown; i++) {
                if (i > 0) sb.append(", ");
                sb.append(names.get(i));
            }
            if (n > shown) sb.append(" +").append(n - shown).append(" more");
            sb.append(")");
        }
        sb.append(" — fix ").append(acc == null ? "none" : "±" + Math.round(acc) + "m");
        sb.append(", ").append(power == null ? "power unknown" : power);
        return sb.toString();
    }

    /** Local wall-clock HH:mm, for journal lines. */
    private static String hhmm(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date(ms));
    }

    private static String toIso8601Utc(long ms) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(ms));
    }
}

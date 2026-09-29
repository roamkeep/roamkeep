package com.roamkeep.app.geofence;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

/**
 * The claim that keeps one check-in to one POST at a time. The write-ahead
 * queue holds a check-in while its own POST is in flight, and three threads
 * drain that queue; without a claim, a breadcrumb batch landing mid-POST sent
 * the row again and left a duplicate-key error in the family's Postgres log
 * at nearly every crossing.
 */
public class InFlightClaimTest {

    private static String freshId() { return UUID.randomUUID().toString(); }

    @Test public void aSecondClaimIsRefusedWhileTheFirstHolds() {
        String id = freshId();
        assertTrue(GeofenceReceiver.claimInFlight(id));
        try {
            assertFalse(GeofenceReceiver.claimInFlight(id));
        } finally {
            GeofenceReceiver.releaseInFlight(id);
        }
    }

    @Test public void releaseLetsItBeClaimedAgain() {
        // A failed POST releases its claim, and the next drain must be able
        // to retry the row — the write-ahead guarantee depends on it.
        String id = freshId();
        assertTrue(GeofenceReceiver.claimInFlight(id));
        GeofenceReceiver.releaseInFlight(id);
        assertTrue(GeofenceReceiver.claimInFlight(id));
        GeofenceReceiver.releaseInFlight(id);
    }

    @Test public void differentIdsDoNotBlockEachOther() {
        String a = freshId(), b = freshId();
        assertTrue(GeofenceReceiver.claimInFlight(a));
        assertTrue(GeofenceReceiver.claimInFlight(b));
        GeofenceReceiver.releaseInFlight(a);
        GeofenceReceiver.releaseInFlight(b);
    }

    @Test public void nullIsNeverClaimed() {
        assertFalse(GeofenceReceiver.claimInFlight(null));
        GeofenceReceiver.releaseInFlight(null);   // and releasing it is harmless
    }

    @Test public void underContentionExactlyOneThreadWins() throws Exception {
        // The real race: the geofence worker, the location worker and the
        // resume flush all reaching the same queued row at once.
        final String id = freshId();
        final int threads = 16;
        final CountDownLatch start = new CountDownLatch(1);
        final AtomicInteger winners = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            for (int i = 0; i < threads; i++) {
                pool.submit(() -> {
                    start.await();
                    if (GeofenceReceiver.claimInFlight(id)) winners.incrementAndGet();
                    return null;
                });
            }
            start.countDown();
            pool.shutdown();
            assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS));
            assertEquals(1, winners.get());
        } finally {
            GeofenceReceiver.releaseInFlight(id);
        }
    }
}

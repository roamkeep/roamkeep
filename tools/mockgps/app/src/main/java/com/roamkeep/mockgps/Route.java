package com.roamkeep.mockgps;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A polyline, parsed from GPX or KML, plus the cumulative distance along it.
 *
 * Both formats are supported because the two things that write routes
 * disagree: tools/seed-demo.mjs emits each route as .gpx (a point every
 * ~80 m, with a timestamp) and as .kml (a bare LineString with no timing).
 * Timing in the file is IGNORED either way — this app paces the replay from
 * a speed the user sets, which is what makes the injected Location carry a
 * correct speed value. Roamkeep's timeline classifies a trip walk/ride/drive
 * from exactly that field.
 *
 * Deliberately regex rather than XmlPullParser: these files are a few KB of
 * known shape, and a parser would drag in namespace handling for no gain.
 */
public class Route {

    public final double[] lat;
    public final double[] lng;
    /** cum[i] = metres from the start to point i. cum[0] == 0. */
    public final double[] cum;
    public final String format;

    private Route(List<double[]> pts, String format) {
        int n = pts.size();
        lat = new double[n];
        lng = new double[n];
        cum = new double[n];
        this.format = format;
        for (int i = 0; i < n; i++) {
            lat[i] = pts.get(i)[0];
            lng[i] = pts.get(i)[1];
            cum[i] = i == 0 ? 0 : cum[i - 1] + distance(lat[i - 1], lng[i - 1], lat[i], lng[i]);
        }
    }

    public int size() { return lat.length; }
    public double lengthM() { return cum[cum.length - 1]; }

    /** Rebuild in the service from the arrays the activity handed over. */
    public static Route fromArrays(double[] lat, double[] lng) {
        List<double[]> pts = new ArrayList<>(lat.length);
        for (int i = 0; i < lat.length && i < lng.length; i++) pts.add(new double[]{lat[i], lng[i]});
        return new Route(pts, "arrays");
    }

    // ── parsing ──────────────────────────────────────────────

    private static final Pattern GPX_PT =
            Pattern.compile("<(?:trkpt|rtept|wpt)\\b([^>]*)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern KML_COORDS =
            Pattern.compile("<coordinates>(.*?)</coordinates>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    public static Route parse(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int r;
        // A route file is kilobytes. Anything enormous is not a route.
        while ((r = in.read(chunk)) > 0 && buf.size() < 8 * 1024 * 1024) buf.write(chunk, 0, r);
        String s = new String(buf.toByteArray(), StandardCharsets.UTF_8);

        List<double[]> pts = new ArrayList<>();

        Matcher m = GPX_PT.matcher(s);
        while (m.find()) {
            Double la = attr(m.group(1), "lat");
            // GPX says "lon"; accept "lng" too, since plenty of exporters write it.
            Double lo = attr(m.group(1), "lon");
            if (lo == null) lo = attr(m.group(1), "lng");
            if (la != null && lo != null) pts.add(new double[]{la, lo});
        }
        if (!pts.isEmpty()) return build(pts, "GPX");

        m = KML_COORDS.matcher(s);
        while (m.find()) {
            for (String tok : m.group(1).trim().split("\\s+")) {
                String[] p = tok.split(",");
                if (p.length < 2) continue;
                try {
                    // KML is lng,lat[,alt] — the opposite order to GPX, and
                    // the classic way to end up in the Gulf of Guinea.
                    double lo = Double.parseDouble(p[0]);
                    double la = Double.parseDouble(p[1]);
                    pts.add(new double[]{la, lo});
                } catch (NumberFormatException ignored) { }
            }
        }
        if (!pts.isEmpty()) return build(pts, "KML");

        throw new IOException("No <trkpt> and no <coordinates> — is this a GPX or KML route?");
    }

    private static Route build(List<double[]> pts, String format) throws IOException {
        // Consecutive duplicates give a zero-length segment, which would be a
        // divide-by-zero when interpolating.
        List<double[]> clean = new ArrayList<>(pts.size());
        for (double[] p : pts) {
            if (p[0] < -90 || p[0] > 90 || p[1] < -180 || p[1] > 180) continue;
            double[] last = clean.isEmpty() ? null : clean.get(clean.size() - 1);
            if (last != null && distance(last[0], last[1], p[0], p[1]) < 0.5) continue;
            clean.add(p);
        }
        if (clean.size() < 2) throw new IOException("A route needs at least two distinct points.");
        Route route = new Route(clean, format);
        if (route.lengthM() < 1) throw new IOException("That route has no length.");
        return route;
    }

    private static Double attr(String attrs, String name) {
        Matcher m = Pattern.compile(name + "\\s*=\\s*\"([^\"]+)\"", Pattern.CASE_INSENSITIVE).matcher(attrs);
        if (!m.find()) return null;
        try { return Double.parseDouble(m.group(1)); } catch (NumberFormatException e) { return null; }
    }

    // ── geometry ─────────────────────────────────────────────

    public static double distance(double aLat, double aLng, double bLat, double bLng) {
        double R = 6371000;
        double dLat = Math.toRadians(bLat - aLat), dLng = Math.toRadians(bLng - aLng);
        double s = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(aLat)) * Math.cos(Math.toRadians(bLat))
                * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(s));
    }

    public static double bearing(double aLat, double aLng, double bLat, double bLng) {
        double y = Math.sin(Math.toRadians(bLng - aLng)) * Math.cos(Math.toRadians(bLat));
        double x = Math.cos(Math.toRadians(aLat)) * Math.sin(Math.toRadians(bLat))
                - Math.sin(Math.toRadians(aLat)) * Math.cos(Math.toRadians(bLat))
                * Math.cos(Math.toRadians(bLng - aLng));
        return (Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
    }

    /**
     * The position `metres` along the route.
     *
     * Interpolated, not snapped to the nearest source point — which is what
     * makes the file's own sampling irrelevant. A route with a point every
     * 80 m still yields a fix every second at walking pace, so the trail is
     * dense and Roamkeep's movement detector never has to guess.
     *
     * @return { lat, lng, bearing }
     */
    public double[] at(double metres) {
        double total = lengthM();
        if (metres <= 0) return new double[]{lat[0], lng[0], bearing(lat[0], lng[0], lat[1], lng[1])};
        if (metres >= total) {
            int n = size() - 1;
            return new double[]{lat[n], lng[n], bearing(lat[n - 1], lng[n - 1], lat[n], lng[n])};
        }
        int i = 1;
        while (i < cum.length - 1 && cum[i] < metres) i++;
        double segStart = cum[i - 1], segLen = cum[i] - segStart;
        double f = segLen <= 0 ? 0 : (metres - segStart) / segLen;
        return new double[]{
                lat[i - 1] + (lat[i] - lat[i - 1]) * f,
                lng[i - 1] + (lng[i] - lng[i - 1]) * f,
                bearing(lat[i - 1], lng[i - 1], lat[i], lng[i]),
        };
    }
}

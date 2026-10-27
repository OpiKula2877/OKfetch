package cz.opikula.okfetch;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The app's own update from the newest GitHub release (the Windows app does the same in src/main/updates.ts). The APK
 * is downloaded into the cache in the background and kept only when its size and SHA-256 match the release. Installing
 * waits for the user: Android shows its own confirmation and refuses an APK signed with another key.
 */
final class AppUpdater {
    private static final String REPO = "OpiKula2877/OKfetch";
    private static final String ASSET = "OKfetch.apk";
    private static final long FIRST_CHECK_MS = 20_000;
    private static final long CHECK_EVERY_MS = 6 * 60 * 60 * 1000L;
    private static final Pattern VERSION = Pattern.compile("v?(\\d{1,6})\\.(\\d{1,6})\\.(\\d{1,6})");
    private static AppUpdater instance;

    /** Gets the state after every change; the plugin passes it on to the WebView. */
    interface Listener {
        void onState(JSObject state);
    }

    private final Context context;
    private final String current;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable periodic = new Runnable() {
        @Override
        public void run() {
            check();
            handler.postDelayed(this, CHECK_EVERY_MS);
        }
    };
    private volatile Listener listener;
    private JSObject state;
    private File installer;
    private boolean running;
    private boolean scheduled;

    private AppUpdater(Context context) {
        this.context = context;
        this.current = versionName(context);
        this.state = stateOf("idle", null, null, null);
    }

    /** One updater for the whole process: the activity can be recreated, the download must go on. */
    static synchronized AppUpdater get(Context context) {
        if (instance == null) instance = new AppUpdater(context.getApplicationContext());
        return instance;
    }

    /** Android lets an app install others only after the user allowed it for OKfetch in the system settings. */
    static boolean canInstall(Context context) {
        return context.getPackageManager().canRequestPackageInstalls();
    }

    /** Is `candidate` a newer x.y.z than `current`? Anything else is never newer. */
    static boolean isNewer(String candidate, String current) {
        int[] next = parseVersion(candidate);
        int[] now = parseVersion(current);
        if (next == null || now == null) return false;
        for (int i = 0; i < 3; i++) if (next[i] != now[i]) return next[i] > now[i];
        return false;
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    synchronized JSObject snapshot() {
        return state;
    }

    /** The downloaded APK, or null while no release is ready to install. */
    synchronized File installer() {
        return installer;
    }

    /** Checks soon after the start and then every few hours. Debug builds are signed with another key and never update. */
    synchronized void start() {
        if (scheduled || (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) return;
        scheduled = true;
        handler.postDelayed(periodic, FIRST_CHECK_MS);
    }

    /** Looks for a newer release and downloads it in the background. Nothing is installed here. */
    synchronized void check() {
        if (running || installer != null) return;
        running = true;
        publish(stateOf("checking", null, null, null));
        new Thread(this::run, "okfetch-update").start();
    }

    private void run() {
        try {
            JSONObject release = latestRelease();
            if (release == null || !isNewer(release.getString("version"), current)) {
                finish(stateOf("upToDate", null, null, null), null);
                return;
            }
            String version = release.getString("version");
            File dir = new File(context.getCacheDir(), "updates");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("The update folder cannot be made.");
            File[] old = dir.listFiles();
            if (old != null) for (File file : old) file.delete();
            File target = new File(dir, "OKfetch-" + version + ".apk");
            publish(stateOf("downloading", version, 0, null));
            download(release.getString("url"), release.getLong("size"), release.getString("sha256"), target, (percent) -> publish(stateOf("downloading", version, percent, null)));
            finish(stateOf("ready", version, null, null), target);
        } catch (Exception error) {
            finish(stateOf("error", null, null, error.getMessage()), null);
        }
    }

    private synchronized void finish(JSObject next, File ready) {
        running = false;
        if (ready != null) installer = ready;
        publish(next);
    }

    private synchronized void publish(JSObject next) {
        state = next;
        Listener target = listener;
        if (target != null) target.onState(next);
    }

    private JSObject stateOf(String status, String latest, Integer progress, String error) {
        JSObject object = new JSObject();
        object.put("status", status);
        object.put("current", current);
        if (latest != null) object.put("latest", latest);
        if (progress != null) object.put("progress", progress.intValue());
        if (error != null) object.put("error", error);
        return object;
    }

    /** The newest release as {version, url, size, sha256}; null when it has no APK with a SHA-256 digest. */
    private JSONObject latestRelease() throws Exception {
        JSONObject data = new JSONObject(get("https://api.github.com/repos/" + REPO + "/releases/latest", "application/vnd.github+json"));
        JSONArray assets = data.optJSONArray("assets");
        if (assets == null) return null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!ASSET.equals(asset.optString("name"))) continue;
            String url = asset.optString("browser_download_url", "");
            String digest = asset.optString("digest", "");
            long size = asset.optLong("size", 0);
            if (!url.startsWith("https://github.com/" + REPO + "/releases/download/")) return null;
            if (!digest.matches("sha256:[0-9a-f]{64}") || size <= 0) return null;
            String tag = data.optString("tag_name", "");
            JSONObject release = new JSONObject();
            release.put("version", tag.startsWith("v") ? tag.substring(1) : tag);
            release.put("url", url);
            release.put("size", size);
            release.put("sha256", digest.substring("sha256:".length()));
            return release;
        }
        return null;
    }

    /** Downloads the APK into `target`; it is kept only when its size and SHA-256 match the release. */
    private void download(String url, long size, String sha256, File target, IntConsumer progress) throws Exception {
        File partial = new File(target.getParentFile(), target.getName() + ".part");
        HttpURLConnection connection = open(url);
        connection.setReadTimeout(60_000);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long received = 0;
        int last = -1;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                digest.update(buffer, 0, read);
                received += read;
                int percent = (int) Math.min(99, received * 100 / size);
                if (percent != last) {
                    last = percent;
                    progress.accept(percent);
                }
            }
        } finally {
            connection.disconnect();
        }
        if (received != size || !hex(digest.digest()).equals(sha256)) {
            partial.delete();
            throw new Exception("The download does not match the release.");
        }
        if (!partial.renameTo(target)) throw new Exception("The update cannot be kept.");
    }

    private String get(String url, String accept) throws Exception {
        HttpURLConnection connection = open(url);
        connection.setRequestProperty("Accept", accept);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) bytes.write(buffer, 0, read);
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("User-Agent", "OKfetch/" + current);
        return connection;
    }

    private static String versionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException error) {
            return "0.0.0";
        }
    }

    private static int[] parseVersion(String text) {
        Matcher match = VERSION.matcher(text.trim());
        if (!match.matches()) return null;
        return new int[] { Integer.parseInt(match.group(1)), Integer.parseInt(match.group(2)), Integer.parseInt(match.group(3)) };
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder();
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }
}

package com.drdoc.app;

import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Receives files shared to Dr.Doc (ACTION_SEND / SEND_MULTIPLE / VIEW), copies them into the
 * app cache while the sender's temporary read permission is valid, and hands them to the web
 * layer through consume().
 */
@CapacitorPlugin(name = "ShareInbox")
public class ShareInboxPlugin extends Plugin {
    private static final String TAG = "ShareInbox";
    private final List<JSObject> pending = new ArrayList<>();

    @Override
    public void load() {
        handle(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (handle(intent)) {
            notifyListeners("shared", new JSObject(), true);
        }
    }

    @PluginMethod
    public synchronized void consume(PluginCall call) {
        JSArray files = new JSArray();
        for (JSObject f : pending) files.put(f);
        pending.clear();
        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    @SuppressWarnings("deprecation")
    private synchronized boolean handle(Intent intent) {
        if (intent == null || intent.getAction() == null) return false;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();

        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else {
            return false;
        }
        ClipData clip = intent.getClipData();
        if (uris.isEmpty() && clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        // Consume the intent so an activity restart doesn't import the same files again.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        if (uris.isEmpty()) return false;

        File root = new File(getContext().getCacheDir(), "shared");
        if (pending.isEmpty()) deleteRecursive(root);
        File dir = new File(root, String.valueOf(System.currentTimeMillis()));
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();

        boolean any = false;
        for (Uri uri : uris) {
            try {
                String mime = getContext().getContentResolver().getType(uri);
                String name = sanitize(displayName(uri, mime));
                File out = new File(dir, name);
                for (int n = 1; out.exists(); n++) out = new File(dir, n + "_" + name);
                try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                     OutputStream os = new FileOutputStream(out)) {
                    if (in == null) continue;
                    byte[] buf = new byte[64 * 1024];
                    int r;
                    while ((r = in.read(buf)) != -1) os.write(buf, 0, r);
                }
                JSObject f = new JSObject();
                f.put("name", out.getName());
                f.put("path", out.getAbsolutePath());
                f.put("mimeType", mime != null ? mime : "");
                pending.add(f);
                any = true;
            } catch (Exception e) {
                Log.e(TAG, "Could not import " + uri, e);
            }
        }
        return any;
    }

    private String displayName(Uri uri, String mime) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "shared-file";
        if (!name.contains(".") && mime != null) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (ext != null) name = name + "." + ext;
        }
        return name;
    }

    private static String sanitize(String name) {
        String n = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\\\:*?\"<>|]", "_");
        return n.isEmpty() ? "shared-file" : n;
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}

package com.termux.app;

import android.app.Activity;
import android.content.res.AssetManager;

import com.termux.app.terminal.TermuxTerminalSessionActivityClient;
import com.termux.shared.logger.Logger;
import com.termux.shared.termux.TermuxConstants;
import com.termux.shared.termux.shell.command.runner.terminal.TermuxSession;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * QQRobot (dev.qqrobot.f2b) first-run bootstrap.
 * <p>
 * Runs after the official Termux bootstrap is installed (whenDone callback of
 * {@link TermuxInstaller#setupBootstrapIfNeeded(Activity, Runnable)}).
 * <p>
 * Logic:
 * <ul>
 *     <li>Marker file {@code $FILES/.qqrobot-ready} set by the first-run shell
 *     script means the container rootfs is fully provisioned — normal sessions
 *     should then be used as in stock Termux.</li>
 *     <li>Before that, the first-run script ({@code assets/qqrobot-firstrun.sh}
 *     and {@code assets/qqrobot-rootfs-url.txt}) is copied into the app files
 *     directory and executed as a terminal session: it downloads the rootfs
 *     tarball, extracts it under {@code $FILES/rootfs}, installs proot, does an
 *     idempotent health check, starts the proot container holding NapCat/QQ and
 *     the bot backend, and finally opens the control panel.</li>
 * </ul>
 * The first-run session itself is a normal {@link TermuxSession}, so the user
 * sees progress on the terminal (consistent with the chosen "terminal shell"
 * V1 look). The Android API {@code android.os.FileUtils} (API 29+) is
 * available since minSdk 21 via coreLibraryDesugaring; we avoid it below and
 * use a plain byte-stream copy to keep the copy code independent of SDK level.
 */
public final class QQRobotFirstRun {

    private static final String LOG_TAG = "QQRobotFirstRun";

    /** Marker file written by the first-run script when provisioning fully succeeded. */
    private static final String READY_MARKER = ".qqrobot-ready";

    /** Asset names. */
    private static final String ASSET_SCRIPT = "qqrobot-firstrun.sh";
    private static final String ASSET_ROOTFS_URL = "qqrobot-rootfs-url.txt";

    private QQRobotFirstRun() {}

    /**
     * Returns whether the container rootfs has already been provisioned.
     */
    public static boolean isReady(Activity activity) {
        if (activity == null) return false;
        File filesDir = activity.getFilesDir();
        return new File(filesDir, READY_MARKER).isFile();
    }

    /**
     * Copies the first-run script and its rootfs URL file from assets into the
     * app files directory (idempotent: overwrites, returns false on copy failure).
     */
    private static boolean copyAssets(Activity activity) {
        AssetManager assetManager = activity.getAssets();
        String[] assets = {ASSET_SCRIPT, ASSET_ROOTFS_URL};
        File filesDir = activity.getFilesDir();
        boolean ok = true;
        for (String assetName : assets) {
            File target = new File(filesDir, assetName);
            try (InputStream in = assetManager.open(assetName);
                 OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                if (ASSET_SCRIPT.equals(assetName)) {
                    // Make executable for direct execution convenience.
                    target.setExecutable(true, false);
                }
            } catch (IOException e) {
                Logger.logError(LOG_TAG, "Failed to copy asset " + assetName + ": " + e.getMessage());
                ok = false;
            }
        }
        return ok;
    }

    /**
     * Runs the first-run terminal session, or returns false if the rootfs is
     * already provisioned (caller should then proceed as in stock Termux).
     *
     * @return true if a first-run session was started, false if not needed
     *         or if starting it failed.
     */
    public static boolean startFirstRunIfNeeded(Activity activity,
                                                TermuxService service,
                                                TermuxTerminalSessionActivityClient sessionClient) {
        if (isReady(activity)) return false;
        Logger.logInfo(LOG_TAG, "Rootfs not provisioned yet — starting first-run session");

        if (!copyAssets(activity)) {
            Logger.logError(LOG_TAG, "Could not copy first-run assets; falling back to normal session");
            return false;
        }

        File filesDir = activity.getFilesDir();
        File script = new File(filesDir, ASSET_SCRIPT);

        String bashPath = TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/bin/bash";
        String workingDirectory = filesDir.getAbsolutePath();
        String sessionName = "QQ机器人初始化";

        TermuxSession session = service.createTermuxSession(bashPath,
                new String[]{script.getAbsolutePath()},
                null, workingDirectory, false, sessionName);
        if (session == null) {
            Logger.logError(LOG_TAG, "Could not create first-run TermuxSession");
            return false;
        }

        sessionClient.setCurrentSession(session.getTerminalSession());
        return true;
    }
}
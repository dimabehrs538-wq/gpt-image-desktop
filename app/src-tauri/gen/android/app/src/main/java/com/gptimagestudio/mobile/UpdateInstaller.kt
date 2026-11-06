package com.gptimagestudio.mobile

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 应用内更新（不会静默安装，也不绕过系统限制）：
 * 1. 只接受本项目 GitHub Releases 的 https 下载地址；
 * 2. 用系统 DownloadManager 下载到 App 专属目录（通知栏可见进度）；
 * 3. 下载完成后校验：包名一致、版本号更高、签名证书与当前已安装版本一致；
 * 4. 交给系统安装器，由用户在系统界面确认安装。首次需要用户在系统设置中允许本应用“安装未知应用”。
 * 结果通过 window.__gptUpdateEvent({stage, message}) 回调给网页。
 */
class UpdateInstaller(private val activity: Activity, private val webView: WebView) {
  companion object {
    private const val ALLOWED_PREFIX = "https://github.com/dimabehrs538-wq/gpt-image-desktop/releases/download/"
  }

  private var downloadId = -1L
  private var receiver: BroadcastReceiver? = null

  private fun emit(stage: String, message: String) {
    val js = "window.__gptUpdateEvent && window.__gptUpdateEvent(" +
      JSONObject().put("stage", stage).put("message", message).toString() + ")"
    activity.runOnUiThread { webView.evaluateJavascript(js, null) }
  }

  private fun canInstall(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  /** 返回 "ok:downloading" / "permission"（已打开系统授权页，授权后请重试）/ "error:<原因>" */
  fun start(url: String, fileName: String): String {
    return try {
      require(url.startsWith(ALLOWED_PREFIX) && url.endsWith(".apk")) { "只允许下载本项目 GitHub Releases 中的 APK" }
      if (!canInstall()) {
        val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
        activity.runOnUiThread { activity.startActivity(i) }
        return "permission"
      }
      val safe = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "update.apk" }
      val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates").apply { mkdirs() }
      dir.listFiles()?.forEach { it.delete() } // 清理旧安装包
      val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val req = DownloadManager.Request(Uri.parse(url))
        .setTitle("GPT 生图 更新")
        .setDescription(safe)
        .setMimeType("application/vnd.android.package-archive")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        .setDestinationUri(Uri.fromFile(File(dir, safe)))
      registerReceiver(dm, File(dir, safe))
      downloadId = dm.enqueue(req)
      "ok:downloading"
    } catch (e: Exception) {
      "error:" + (e.message ?: e.javaClass.simpleName)
    }
  }

  private fun registerReceiver(dm: DownloadManager, target: File) {
    receiver?.let { runCatching { activity.unregisterReceiver(it) } }
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != downloadId) return
        runCatching { activity.unregisterReceiver(this) }
        receiver = null
        onDownloaded(dm, target)
      }
    }
    receiver = r
    ContextCompat.registerReceiver(activity, r, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED)
  }

  private fun onDownloaded(dm: DownloadManager, file: File) {
    try {
      dm.query(DownloadManager.Query().setFilterById(downloadId)).use { c ->
        if (!c.moveToFirst() || c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) != DownloadManager.STATUS_SUCCESSFUL) {
          emit("error", "下载失败，请检查网络后重试"); return
        }
      }
      verify(file)
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
      val install = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      emit("installing", "下载完成，请在系统安装界面确认更新")
      activity.runOnUiThread { activity.startActivity(install) }
    } catch (e: Exception) {
      file.delete()
      emit("error", e.message ?: e.javaClass.simpleName)
    }
  }

  @Suppress("DEPRECATION")
  private fun packageInfo(archive: File?): PackageInfo? {
    val pm = activity.packageManager
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    return if (archive == null) pm.getPackageInfo(activity.packageName, flags)
    else pm.getPackageArchiveInfo(archive.path, flags)
  }

  @Suppress("DEPRECATION")
  private fun certDigests(p: PackageInfo): Set<String> {
    val sigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) p.signingInfo?.apkContentsSigners else p.signatures
    return sigs.orEmpty().map { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
  }

  @Suppress("DEPRECATION")
  private fun versionCode(p: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) p.longVersionCode else p.versionCode.toLong()

  private fun verify(file: File) {
    val next = packageInfo(file) ?: throw IllegalStateException("安装包无法解析，可能下载不完整")
    val cur = packageInfo(null)!!
    if (next.packageName != activity.packageName) throw IllegalStateException("安装包包名不匹配（${next.packageName}）")
    if (versionCode(next) <= versionCode(cur)) throw IllegalStateException("安装包版本（${next.versionName}）不高于当前版本（${cur.versionName}）")
    if (certDigests(next) != certDigests(cur))
      throw IllegalStateException("新版本签名与当前安装的版本不一致，系统不允许覆盖安装。请先备份作品（画廊 → 保存到相册），卸载当前版本后再安装新版")
  }
}

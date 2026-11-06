package com.gptimagestudio.mobile

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import java.io.File

/**
 * 暴露给网页的 window.GPTImageAndroid：
 * - saveImage(path, name)：写入系统相册 Pictures/GPTImageStudio（Android 10+ 无需存储权限），返回 "ok:<uri>" / "unsupported" / "error:<原因>"
 * - shareImage(path, name)：复制到缓存目录后通过 FileProvider 调起系统分享面板，返回 "ok" / "error:<原因>"
 *
 * 只允许读取本应用沙盒内（内核输出目录）的图片文件。
 */
class ImageBridge(private val activity: Activity) {
  private val allowedExt = setOf("png", "jpg", "jpeg", "webp", "gif")

  private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "jpg", "jpeg" -> "image/jpeg"
    "webp" -> "image/webp"
    "gif" -> "image/gif"
    else -> "image/png"
  }

  private fun checkedFile(path: String): File {
    val f = File(path).canonicalFile
    val appDirs = listOfNotNull(activity.filesDir.parentFile?.canonicalFile, activity.getExternalFilesDir(null)?.canonicalFile)
    require(appDirs.any { f.path.startsWith(it.path + File.separator) }) { "只能导出应用内的图片" }
    require(f.extension.lowercase() in allowedExt) { "不是图片文件" }
    require(f.isFile) { "图片文件不存在" }
    return f
  }

  private fun safeName(name: String, f: File): String {
    val n = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
    return if (n.isEmpty()) f.name else n
  }

  @JavascriptInterface
  fun saveImage(path: String, name: String): String {
    return try {
      val f = checkedFile(path)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unsupported"
      val resolver = activity.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, safeName(name, f))
        put(MediaStore.Images.Media.MIME_TYPE, mimeOf(f.name))
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/GPTImageStudio")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        ?: return "error:无法创建相册条目"
      resolver.openOutputStream(uri).use { out ->
        requireNotNull(out) { "无法写入相册" }
        f.inputStream().use { it.copyTo(out) }
      }
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      "ok:$uri"
    } catch (e: Exception) {
      "error:" + (e.message ?: e.javaClass.simpleName)
    }
  }

  @JavascriptInterface
  fun shareImage(path: String, name: String): String {
    return try {
      val f = checkedFile(path)
      val dir = File(activity.cacheDir, "shared").apply { mkdirs() }
      val out = File(dir, safeName(name, f))
      f.copyTo(out, overwrite = true)
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", out)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mimeOf(out.name)
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.runOnUiThread {
        activity.startActivity(Intent.createChooser(send, "分享图片").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
      }
      "ok"
    } catch (e: Exception) {
      "error:" + (e.message ?: e.javaClass.simpleName)
    }
  }
}

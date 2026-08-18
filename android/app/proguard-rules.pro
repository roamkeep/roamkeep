# Roamkeep R8/ProGuard rules.
#
# Goal: obfuscate our code and strip dead weight WITHOUT breaking the
# Capacitor JS<->Java bridge, which discovers plugins and their methods
# reflectively — anything it looks up by name must keep its name.

# ── Capacitor bridge ───────────────────────────────────────
# Plugin classes are located by name and their @PluginMethod methods are
# invoked reflectively from the WebView; annotations must survive too.
-keep public class * extends com.getcapacitor.Plugin
-keep @com.getcapacitor.annotation.CapacitorPlugin public class *
-keepclassmembers class * {
  @com.getcapacitor.PluginMethod public <methods>;
  @com.getcapacitor.annotation.PermissionCallback <methods>;
  @com.getcapacitor.annotation.ActivityCallback <methods>;
}
-keepattributes *Annotation*

# The bridge itself (JSObject/JSArray etc. cross the reflection line).
-keep class com.getcapacitor.** { *; }
-keep class org.apache.cordova.** { *; }

# WebView JavaScript interfaces are called by name from JS.
-keepclassmembers class * {
  @android.webkit.JavascriptInterface <methods>;
}

# ── ML Kit barcode scanning (setup-QR on the Connect screen) ──
# The scanner is reached through Play Services' on-demand module, which
# is resolved reflectively; R8 must not strip the entry points.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-dontwarn com.google.mlkit.**

# ── Diagnostics ────────────────────────────────────────────
# Keep file/line info so release crash stack traces stay mappable
# (R8 still writes mapping.txt under app/build/outputs/mapping/release —
# keep that file per release if you want to de-obfuscate traces).
-keepattributes SourceFile,LineNumberTable

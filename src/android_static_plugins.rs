//! Static GStreamer registry for the official Android SDK.
//!
//! Android's GStreamer core calls `gst_init_static_plugins` from `gst_init()`.
//! Providing the hook here keeps the Tauri package to one native library while
//! registering only the plugins used by the streaming engine.

use jni::{
    objects::{GlobalRef, JClass, JObject, JString},
    sys::jobject,
    JNIEnv,
};
use std::{
    ffi::{c_char, c_void, CString},
    sync::OnceLock,
};

struct AndroidJniContext {
    java_vm: *mut c_void,
    application_context: GlobalRef,
    class_loader: GlobalRef,
}

// All three values are JNI global/process references and remain valid until
// Android unloads the application DSO.
unsafe impl Send for AndroidJniContext {}
unsafe impl Sync for AndroidJniContext {}

static ANDROID_JNI_CONTEXT: OnceLock<AndroidJniContext> = OnceLock::new();
static TLS_CA_FILE: OnceLock<String> = OnceLock::new();

macro_rules! static_plugins {
    ($($plugin:ident),+ $(,)?) => {
        unsafe extern "C" {
            $(fn $plugin() -> i32;)+
        }

        unsafe fn register_all() {
            $(let _ = $plugin();)+
        }
    };
}

static_plugins!(
    gst_plugin_coreelements_register,
    gst_plugin_playback_register,
    gst_plugin_app_register,
    gst_plugin_soup_register,
    gst_plugin_typefindfunctions_register,
    gst_plugin_matroska_register,
    gst_plugin_isomp4_register,
    gst_plugin_videoconvertscale_register,
    gst_plugin_audioconvert_register,
    gst_plugin_audioresample_register,
    gst_plugin_audioparsers_register,
    gst_plugin_videoparsersbad_register,
    gst_plugin_libav_register,
    gst_plugin_opus_register,
    gst_plugin_vorbis_register,
    gst_plugin_vpx_register,
    gst_plugin_flac_register,
    gst_plugin_avi_register,
    gst_plugin_mpegtsdemux_register,
    gst_plugin_subparse_register,
    gst_plugin_volume_register,
    gst_plugin_autodetect_register,
    gst_plugin_pbtypes_register,
    gst_plugin_openh264_register,
);

unsafe extern "C" {
    fn g_io_openssl_load(data: *mut c_void);
    fn gst_amc_jni_set_java_vm(java_vm: *mut c_void);
    fn gst_plugin_androidmedia_register() -> i32;
    fn __android_log_write(priority: i32, tag: *const c_char, text: *const c_char) -> i32;
}

#[cfg(target_arch = "arm")]
unsafe extern "C" {
    static mut OPENSSL_armcap_P: u32;
}

#[cfg(target_arch = "arm")]
fn disable_broken_armv8_crypto() {
    // OPENSSL_armcap is normally consumed by a library constructor, before
    // Java can call nativeInit. Override the already-initialized capability
    // word directly so 32-bit firmware cannot select ARMv8 AES instructions.
    unsafe {
        std::ptr::write_volatile(std::ptr::addr_of_mut!(OPENSSL_armcap_P), 0);
    }
}

#[cfg(not(target_arch = "arm"))]
fn disable_broken_armv8_crypto() {}

fn android_log(message: &str) {
    let Ok(message) = CString::new(message) else {
        return;
    };
    // ANDROID_LOG_INFO. This deliberately bypasses Rust logging because this
    // hook runs inside gst_init(), before an application's subscriber exists.
    unsafe {
        __android_log_write(4, c"tauri-plugin-video".as_ptr(), message.as_ptr());
    }
}

/// Initialize GStreamer with process-wide JNI global references. Defining the
/// bridge in Rust also makes the three provider symbols below visible from the
/// final cdylib; AndroidMedia resolves them with `g_module_symbol()`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_org_freedesktop_gstreamer_GStreamer_nativeInit(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
) {
    let initialization = (|| -> Result<(), String> {
        // GIO's OpenSSL backend does not automatically inherit Android's Java
        // trust manager. Point OpenSSL at the platform's hashed system roots so
        // public HTTPS media works without disabling certificate verification.
        std::env::set_var("SSL_CERT_DIR", "/system/etc/security/cacerts");
        #[cfg(target_arch = "arm")]
        // Some 32-bit Android TV firmware advertises ARMv8 AES support while
        // running an ABI/crypto combination that crashes OpenSSL's aes_v8 path.
        // This only selects OpenSSL's portable TLS implementation; MediaCodec
        // hardware acceleration is independent of this setting.
        std::env::set_var("OPENSSL_armcap", "0");
        disable_broken_armv8_crypto();
        if ANDROID_JNI_CONTEXT.get().is_none() {
            let java_vm = env.get_java_vm().map_err(|error| error.to_string())?;
            let class_loader = env
                .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
                .and_then(|value| value.l())
                .map_err(|error| error.to_string())?;
            let application_context = env
                .new_global_ref(&context)
                .map_err(|error| error.to_string())?;
            let class_loader = env
                .new_global_ref(class_loader)
                .map_err(|error| error.to_string())?;
            let _ = ANDROID_JNI_CONTEXT.set(AndroidJniContext {
                java_vm: java_vm.get_java_vm_pointer().cast(),
                application_context,
                class_loader,
            });
        }
        gstreamer::init().map_err(|error| error.to_string())?;
        Ok(())
    })();

    if let Err(error) = initialization {
        android_log(&format!("GStreamer JNI initialization failed: {error}"));
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    } else {
        android_log("GStreamer JNI initialization complete");
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_taurivideo_plugin_GStreamerBootstrap_setTlsCaFile(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    path: JString<'_>,
) {
    disable_broken_armv8_crypto();
    if let Ok(path) = env.get_string(&path) {
        let path = path.to_string_lossy().into_owned();
        std::env::set_var("SSL_CERT_FILE", &path);
        let _ = TLS_CA_FILE.set(path);
    }
}

pub(crate) fn tls_ca_file() -> Option<&'static str> {
    TLS_CA_FILE.get().map(String::as_str)
}

#[unsafe(no_mangle)]
pub extern "C" fn gst_android_get_application_context() -> jobject {
    ANDROID_JNI_CONTEXT
        .get()
        .map_or(std::ptr::null_mut(), |context| {
            context.application_context.as_obj().as_raw()
        })
}

#[unsafe(no_mangle)]
pub extern "C" fn gst_android_get_application_class_loader() -> jobject {
    ANDROID_JNI_CONTEXT
        .get()
        .map_or(std::ptr::null_mut(), |context| {
            context.class_loader.as_obj().as_raw()
        })
}

#[unsafe(no_mangle)]
pub extern "C" fn gst_android_get_java_vm() -> *mut c_void {
    ANDROID_JNI_CONTEXT
        .get()
        .map_or(std::ptr::null_mut(), |context| context.java_vm)
}

/// Android's application ClassLoader is installed by `GStreamer.nativeInit`
/// only after the core `gst_init()` call. Register AndroidMedia in the next
/// JNI call so its codec scan can resolve application bridge classes.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_io_github_taurivideo_plugin_GStreamerBootstrap_registerAndroidMedia(
    _env: *mut c_void,
    _class: *mut c_void,
) -> u8 {
    let registered = gst_plugin_androidmedia_register() != 0;
    android_log(&format!(
        "AndroidMedia post-init registration returned {registered}"
    ));
    u8::from(registered)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn gst_init_static_plugins() {
    // GStreamer's AndroidMedia plugin discovers MediaCodec through JNI. Tao
    // owns the Activity/VM for a Tauri app, so pass that same VM into the
    // plugin before it registers decoder factories.
    if let Some(android) = ANDROID_JNI_CONTEXT.get() {
        gst_amc_jni_set_java_vm(android.java_vm);
        android_log("provided application JavaVM to GStreamer AndroidMedia");
    } else {
        android_log("Android JNI context unavailable during GStreamer initialization");
    }

    register_all();
    g_io_openssl_load(std::ptr::null_mut());
}

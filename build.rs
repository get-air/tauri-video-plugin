const COMMANDS: &[&str] = &[
    "runtime_capabilities",
    "create_session",
    "set_playback_state",
    "seek",
    "select_track",
    "update_visibility",
    "session_stats",
    "destroy_session",
    "native_open",
    "native_control",
    "native_layout",
    "native_stats",
    "native_close",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();

    println!("cargo:rerun-if-env-changed=GSTREAMER_ROOT_ANDROID");
    println!("cargo:rerun-if-env-changed=GSTREAMER_1_0_ROOT_MSVC_X86_64");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // Android's loader rejects unresolved native symbols at application
        // startup. Make them a build-time error instead.
        println!("cargo:rustc-link-arg=-Wl,-z,defs");
        let (abi, ndk_triple) = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => ("arm64", "aarch64-linux-android"),
            Ok("arm") => ("armv7", "arm-linux-androideabi"),
            Ok("x86") => ("x86", "i686-linux-android"),
            Ok("x86_64") => ("x86_64", "x86_64-linux-android"),
            _ => return,
        };
        let mut arm_builtins_dir = None;
        if let Ok(ndk_home) = std::env::var("NDK_HOME") {
            let prebuilt = std::path::Path::new(&ndk_home).join("toolchains/llvm/prebuilt");
            if let Ok(mut entries) = std::fs::read_dir(prebuilt) {
                if let Some(Ok(host)) = entries.next() {
                    let cxx_runtime = host
                        .path()
                        .join("sysroot/usr/lib")
                        .join(ndk_triple)
                        .join("libc++_shared.so");
                    if let Ok(out_dir) = std::env::var("OUT_DIR") {
                        let staged = std::path::Path::new(&out_dir).join("libc++_shared.so");
                        std::fs::copy(&cxx_runtime, &staged)
                            .expect("failed to stage the Android C++ runtime");
                        println!("cargo:rustc-link-search=native={out_dir}");
                    }
                    if abi == "armv7" {
                        let clang_root = host.path().join("lib/clang");
                        if let Ok(versions) = std::fs::read_dir(clang_root) {
                            let archive = versions.filter_map(Result::ok).find_map(|version| {
                                let archive = version
                                    .path()
                                    .join("lib/linux/libclang_rt.builtins-arm-android.a");
                                archive.is_file().then_some(archive)
                            });
                            if let (Some(archive), Ok(out_dir)) =
                                (archive, std::env::var("OUT_DIR"))
                            {
                                let output = std::path::PathBuf::from(out_dir);
                                let status =
                                    std::process::Command::new(host.path().join("bin/llvm-ar"))
                                        .current_dir(&output)
                                        .arg("x")
                                        .arg(archive)
                                        .args(["clear_cache.c.o", "os_version_check.c.o"])
                                        .status()
                                        .expect("failed to run llvm-ar for Android armv7 builtins");
                                assert!(
                                    status.success(),
                                    "failed to extract Android armv7 builtins"
                                );
                                let bundled = output.join("libtauri_video_arm_builtins.a");
                                let status =
                                    std::process::Command::new(host.path().join("bin/llvm-ar"))
                                        .current_dir(&output)
                                        .args(["crs", "libtauri_video_arm_builtins.a"])
                                        .args(["clear_cache.c.o", "os_version_check.c.o"])
                                        .status()
                                        .expect("failed to bundle Android armv7 builtins");
                                assert!(status.success() && bundled.is_file());
                                arm_builtins_dir = Some(output);
                            }
                        }
                    }
                }
            }
        }
        if let Ok(root) = std::env::var("GSTREAMER_ROOT_ANDROID") {
            println!("cargo:rustc-link-search=native={root}/{abi}/lib");
            println!("cargo:rustc-link-search=native={root}/{abi}/lib/gstreamer-1.0");
            println!("cargo:rustc-link-search=native={root}/{abi}/lib/gio/modules");

            // Android's official GStreamer SDK ships plugins as static
            // archives. Retain them in full because their entry points are
            // reached through the registry rather than ordinary Rust calls.
            for plugin in [
                "coreelements",
                "playback",
                "app",
                "soup",
                "typefindfunctions",
                "matroska",
                "isomp4",
                "videoconvertscale",
                "audioconvert",
                "audioresample",
                "audioparsers",
                "videoparsersbad",
                "libav",
                "androidmedia",
                "opus",
                "vorbis",
                "vpx",
                "flac",
                "avi",
                "mpegtsdemux",
                "subparse",
                "volume",
                "autodetect",
                "pbtypes",
                "openh264",
            ] {
                println!("cargo:rustc-link-lib=static:+whole-archive=gst{plugin}");
            }
            println!("cargo:rustc-link-lib=static:+whole-archive=gioopenssl");

            // The official Android SDK is static. Repeating private GLib/ORC
            // dependencies after the sys crates is required for archive-order
            // linkers and prevents deferred undefined symbols at dlopen time.
            for library in [
                "avformat",
                "avcodec",
                "avfilter",
                "swresample",
                "swscale",
                "avutil",
                "soup-3.0",
                "ssl",
                "crypto",
                "openh264",
                "vpx",
                "vorbis",
                "vorbisenc",
                "ogg",
                "opus",
                "FLAC",
                "sqlite3",
                "psl",
                "nghttp2",
                "bz2",
                "gstcodecparsers-1.0",
                "gstallocators-1.0",
                "gstgl-1.0",
                "gstmpegts-1.0",
                "gstphotography-1.0",
                "gstrtp-1.0",
                "gstriff-1.0",
                "gsttag-1.0",
                "gmodule-2.0",
                "ffi",
                "pcre2-8",
                "iconv",
                "intl",
                "orc-0.4",
                "z",
            ] {
                println!("cargo:rustc-link-lib=static={library}");
            }
            // OpenH264 is C++; use the NDK's shared runtime. Tauri detects and
            // packages this non-system dependency beside the application SO.
            println!("cargo:rustc-link-lib=dylib=c++_shared");
            println!("cargo:rustc-link-lib=dylib=EGL");
            println!("cargo:rustc-link-lib=dylib=GLESv2");
            if let Some(directory) = arm_builtins_dir {
                // Native libraries propagate through Cargo dependencies to the
                // final Tauri cdylib; rustc-link-arg object paths do not.
                println!("cargo:rustc-link-search=native={}", directory.display());
                println!("cargo:rustc-link-lib=static:+whole-archive=tauri_video_arm_builtins");
            }
        }
    }
}

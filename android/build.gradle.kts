plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val tauriVideoCaAssets = layout.buildDirectory.dir("generated/tauriVideoCaAssets")
val stageTauriVideoCaBundle by tasks.registering(Copy::class) {
    val gstreamerRoot = providers.environmentVariable("GSTREAMER_ROOT_ANDROID")
    val extraCa = providers.environmentVariable("TAURI_VIDEO_EXTRA_CA")
    val bundledCa = gstreamerRoot
        .map { "$it/arm64/etc/ssl/certs/ca-certificates.crt" }
        .orElse(layout.projectDirectory.file("src/main/assets/tauri-video-ca-certificates.crt").asFile.absolutePath)
    from(bundledCa)
    into(tauriVideoCaAssets)
    rename { "tauri-video-ca-certificates.crt" }
    inputs.property("tauriVideoExtraCa", extraCa.orElse(""))
    doLast {
        extraCa.orNull?.takeIf(String::isNotBlank)?.let { path ->
            val destination = tauriVideoCaAssets.get().file("tauri-video-ca-certificates.crt").asFile
            destination.parentFile.mkdirs()
            if (destination.isFile) destination.appendText("\n${file(path).readText()}\n")
            else destination.writeText(file(path).readText())
        }
    }
}

android {
    namespace = "io.github.taurivideo.plugin"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("proguard-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    sourceSets.getByName("main").apply {
        jniLibs.srcDir("src/main/jniLibs")
        assets.srcDir(tauriVideoCaAssets)
    }
    packaging.resources.excludes += setOf(
        "META-INF/LICENSE",
        "META-INF/LICENSE.txt",
        "META-INF/NOTICE",
        "META-INF/NOTICE.txt"
    )
}

tasks.named("preBuild").configure { dependsOn(stageTauriVideoCaBundle) }

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-exoplayer-dash:1.8.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
    implementation("androidx.media3:media3-datasource-okhttp:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    implementation(project(":tauri-android"))
}

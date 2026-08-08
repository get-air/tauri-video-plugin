plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val tauriVideoCaAssets = layout.buildDirectory.dir("generated/tauriVideoCaAssets")
val stageTauriVideoCaBundle by tasks.registering {
    val extraCa = providers.environmentVariable("TAURI_VIDEO_EXTRA_CA")
    val output = tauriVideoCaAssets.map { it.file("tauri-video-ca-certificates.crt") }
    inputs.property("tauriVideoExtraCa", extraCa.orElse(""))
    outputs.file(output)
    doLast {
        val sources = listOfNotNull(
            extraCa.orNull?.takeIf(String::isNotBlank),
        ).map(::file).distinct().filter { it.isFile }
        val destination = output.get().asFile
        if (sources.isEmpty()) {
            destination.delete()
        } else {
            destination.parentFile.mkdirs()
            destination.writeText(sources.joinToString("\n") { it.readText().trim() } + "\n")
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
    packaging.jniLibs.pickFirsts += setOf("lib/*/libc++_shared.so")
}

tasks.named("preBuild").configure { dependsOn(stageTauriVideoCaBundle) }

val media3Version = "1.10.1"

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.media3:media3-exoplayer:$media3Version")
    implementation("androidx.media3:media3-exoplayer-dash:$media3Version")
    implementation("androidx.media3:media3-exoplayer-hls:$media3Version")
    implementation("androidx.media3:media3-datasource-okhttp:$media3Version")
    implementation("androidx.media3:media3-ui:$media3Version")
    implementation("org.videolan.android:libvlc-all:3.7.5") {
        // LibVLC is Java/JNI; use the host app's Kotlin runtime instead of
        // forcing its newer compiler metadata into Tauri's Android build.
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
    }
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    implementation(project(":tauri-android"))
}

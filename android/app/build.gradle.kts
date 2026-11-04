plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes its run number so every build installs as an update over the previous one.
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

// From the repository secret DEEPSEEK_API_KEY (CI only; never in the repo). Without it the app runs the scripted demo.
val deepseekKey = (System.getenv("DEEPSEEK_API_KEY") ?: "").trim()
require(deepseekKey.matches(Regex("[A-Za-z0-9_-]*"))) { "DEEPSEEK_API_KEY has unexpected characters" }

android {
    namespace = "com.nina.xiaosu"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nina.xiaosu"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
        buildConfigField("String", "DEEPSEEK_API_KEY", "\"$deepseekKey\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // A fixed key, so newer APKs can be installed over older ones without losing data.
    signingConfigs {
        create("release") {
            storeFile = file("xiaosu.p12")
            storeType = "pkcs12"
            storePassword = "xiaosu"
            keyAlias = "xiaosu"
            keyPassword = "xiaosu"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        checkReleaseBuilds = false
    }
}

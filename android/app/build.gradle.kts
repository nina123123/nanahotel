plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes its run number so every build installs as an update over the previous one.
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

// The hosted NanaHotel server (repository variable NANAHOTEL_SERVER_URL), which holds every API key: the app only
// shows its pages. Empty → the app runs its own offline demo (simulated hotels, scripted Nana, no keys anywhere).
val serverUrl = (System.getenv("NANAHOTEL_SERVER_URL") ?: "").trim().trimEnd('/')
require(serverUrl.isEmpty() || serverUrl.matches(Regex("https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*"))) {
    "NANAHOTEL_SERVER_URL must be an https:// address like https://nanahotel.onrender.com"
}

android {
    namespace = "com.nanahotel.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nanahotel.app"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // A fixed key, so newer APKs can be installed over older ones without losing data.
    signingConfigs {
        create("release") {
            storeFile = file("nanahotel.p12")
            storeType = "pkcs12"
            storePassword = "nanahotel"
            keyAlias = "nanahotel"
            keyPassword = "nanahotel"
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

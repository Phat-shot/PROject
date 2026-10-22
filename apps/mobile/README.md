# PROject für Android

Dünne App-Hülle mit [Capacitor](https://capacitorjs.com): Die App öffnet die Server-Instanz (`server.url` in `capacitor.config.json`, Standard `https://project.srz.one`) in einer WebView. Anmeldung, Daten und Updates bleiben auf dem Server; ein neues APK ist nur bei Änderung von Adresse, Name, Symbol oder Capacitor nötig.

## APK aus GitHub Actions

Workflow `.github/workflows/android.yml` (manuell unter „Actions → Android APK → Run workflow“, bei Git-Tags `v*` und bei Änderungen unter `apps/mobile/`):

- **Debug-APK** (immer): Artefakt `PROject-debug-apk`, mit dem Android-Debug-Schlüssel signiert, direkt installierbar („Unbekannte Quellen“ erlauben).
- **Release-APK** (optional): wenn die Secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` gesetzt sind. Keystore einmalig erzeugen und als Base64 hinterlegen:

```bash
keytool -genkeypair -v -keystore project.jks -alias project -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 project.jks   # → Secret ANDROID_KEYSTORE_BASE64
```

Die Server-Adresse lässt sich beim manuellen Start als Eingabe `url` überschreiben (z. B. Staging). Bei Git-Tags hängt der Workflow nur die signierte Release-APK an das Release; die Debug-APK (debuggable, App-Daten per adb lesbar) bleibt Workflow-Artefakt.

## Lokal bauen

```bash
npm install
cd apps/mobile
npx cap add android      # einmalig, erzeugt android/ (nicht eingecheckt)
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Voraussetzungen: JDK 17, Android SDK (Android Studio oder `sdkmanager`).

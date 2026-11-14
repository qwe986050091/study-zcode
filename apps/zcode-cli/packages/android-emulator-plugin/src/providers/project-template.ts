/**
 * 最小 Android 工程模板：提供 settings、根/模块 Gradle 脚本、版本目录、Manifest、资源与 MainActivity 的内容生成器。
 *
 * 职责边界：只负责「路径 + 内容工厂」，不写盘、不校验参数；写盘与覆盖保护在 project.ts。
 * 输入输出：templateFiles 返回文件列表，body 延迟渲染，便于 create() 统一决定写入时机。
 * 数据口径：版本号集中在 libs.versions.toml（AGP/Kotlin/Compose BOM），避免脚本里散落版本；
 * local.properties 仅当解析到 SDK 路径时才生成，且 Windows 反斜杠需转义成 Java properties 形式。
 * 无副作用；模板内容为字符串，改动会影响 android_create_app 的产物与可构建性。
 */
import path from "node:path";

/**
 * 渲染模板所需的上下文：compileSdk/minSdk 为数值，name 用于 rootProject 与 app_name，pkg 用于 namespace/applicationId。
 */
type TemplateInput = {
  compileSdk: number;
  minSdk: number;
  name: string;
  pkg: string;
};

/**
 * 一个待写入的模板文件：path 为绝对路径，body 为按输入渲染内容的工厂。
 * 用工厂而非固定字符串，是为了让同一份模板列表服务不同 name/pkg/SDK 的工程。
 */
type TemplateFile = {
  body: (input: TemplateInput) => string;
  path: string;
};

/**
 * 生成完整模板文件清单（不含磁盘操作）。
 *
 * 输入 root 为目标工程根目录，pkg 决定 MainActivity 的包路径，sdk 为可选的 SDK 绝对路径。
 * 输出顺序固定为构建脚本 → 配置 → 资源 → 源码，便于调用方按稳定顺序写盘与报错。
 * local.properties 只在 sdk 存在时加入：缺失时让 Gradle 从环境变量推断，避免写入错误的 sdk.dir。
 * pkg 的点号在这里转换为目录分隔符，Windows/Unix 均由 path.join 处理。
 */
export function templateFiles(root: string, pkg: string, sdk?: string): TemplateFile[] {
  const pkgDir = pkg.replaceAll(".", "/");
  return [
    { path: path.join(root, "settings.gradle.kts"), body: settings },
    { path: path.join(root, "build.gradle.kts"), body: rootBuild },
    { path: path.join(root, "gradle.properties"), body: gradleProperties },
    ...(sdk
      ? [{ path: path.join(root, "local.properties"), body: () => localProperties(sdk) }]
      : []),
    { path: path.join(root, "gradle", "libs.versions.toml"), body: versions },
    { path: path.join(root, "app", "build.gradle.kts"), body: appBuild },
    { path: path.join(root, "app", "src", "main", "AndroidManifest.xml"), body: manifest },
    { path: path.join(root, "app", "src", "main", "res", "values", "strings.xml"), body: strings },
    { path: path.join(root, "app", "src", "main", "res", "values", "styles.xml"), body: styles },
    {
      path: path.join(root, "app", "src", "main", "java", pkgDir, "MainActivity.kt"),
      body: activity,
    },
  ];
}

/**
 * 生成 settings.gradle.kts：声明仓库与 root 工程名，并 include app 模块。
 * 仓库顺序固定 google → mavenCentral → gradlePluginPortal，保证 Android 插件优先命中官方源。
 */
function settings(input: TemplateInput) {
  return `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${input.name}"
include(":app")
`;
}

/**
 * 生成根 build.gradle.kts：只通过 version catalog 声明插件并 apply false，
 * 真正启用留给模块脚本，避免根工程被误当作应用模块。
 */
function rootBuild() {
  return `plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
`;
}

/**
 * 生成 gradle.properties：开启 AndroidX 与 nonTransitiveRClass（Compose 必需），
 * 并限制 JVM 内存、固定 UTF-8 编码，避免中文资源在 Windows 默认编码下乱码。
 */
function gradleProperties() {
  return `android.useAndroidX=true
android.nonTransitiveRClass=true
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
`;
}

/**
 * 生成 local.properties，写入 sdk.dir。
 * Java properties 把反斜杠视为转义符，因此 Windows 路径的反斜杠必须成对转义，否则 SDK 路径会被吞字符。
 */
function localProperties(sdk: string) {
  return `sdk.dir=${sdk.replaceAll("\\", "\\\\")}
`;
}

/**
 * 生成 libs.versions.toml：集中 AGP、Kotlin、AndroidX 与 Compose BOM 版本，
 * 作为唯一版本来源，避免根脚本与模块脚本版本漂移。
 */
function versions() {
  return `[versions]
agp = "8.7.3"
kotlin = "2.0.21"
coreKtx = "1.15.0"
activityCompose = "1.9.3"
composeBom = "2024.12.01"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
`;
}

/**
 * 生成 app 模块 build.gradle.kts：启用 Android/Kotlin/Compose 插件，
 * 使用 pkg 作为 namespace 与 applicationId，minSdk 与 compileSdk 由输入决定，targetSdk 跟随 compileSdk。
 */
function appBuild(input: TemplateInput) {
  return `plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "${input.pkg}"
    compileSdk = ${input.compileSdk}

    defaultConfig {
        applicationId = "${input.pkg}"
        minSdk = ${input.minSdk}
        targetSdk = ${input.compileSdk}
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
}
`;
}

/**
 * 生成 AndroidManifest.xml：注册 exported 的 MainActivity 与 LAUNCHER intent-filter，
 * 使 android_launch_app 的 monkey/launcher 解析路径能找到入口。
 */
function manifest() {
  return `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;
}

/**
 * 生成 strings.xml，把工程名写入 app_name，供 Manifest 的 android:label 引用。
 * 工程名若含 XML 特殊字符可能破坏资源编译，此处依赖上游 cleanName 已做净化。
 */
function strings(input: TemplateInput) {
  return `<resources>
    <string name="app_name">${input.name}</string>
</resources>
`;
}

/**
 * 生成 styles.xml：使用系统 Material 无 ActionBar 主题，避免依赖 AppCompat/Material 组件库，
 * 保持模板最小依赖集，便于在模拟器上快速构建运行。
 */
function styles() {
  return `<resources>
    <style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar" />
</resources>
`;
}

/**
 * 生成 MainActivity.kt：Compose 界面包含 Hello 文案、计数文本与自增按钮。
 *
 * 计数文本与按钮显式设置了 contentDescription（countLabel / incrementButton），
 * 是为了给 android_ui_describe/resolve 提供稳定的语义定位点，不依赖可变文本匹配。
 */
function activity(input: TemplateInput) {
  return `package ${input.pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            App()
        }
    }
}

@Composable
fun App() {
    var count by remember { mutableIntStateOf(0) }

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "Hello from Android",
                    style = MaterialTheme.typography.headlineMedium,
                )
                Text(
                    text = "Count: $count",
                    modifier = Modifier.semantics { contentDescription = "countLabel" },
                    style = MaterialTheme.typography.titleLarge,
                )
                Button(
                    onClick = { count += 1 },
                    modifier = Modifier.semantics { contentDescription = "incrementButton" },
                ) {
                    Text("Increment")
                }
            }
        }
    }
}
`;
}

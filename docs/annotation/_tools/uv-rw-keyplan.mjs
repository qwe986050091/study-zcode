// 关键文件补深计划：人工按 DEEP-SPEC 2.2 风险域挑选 116 个文件，分 8 批。
// 同时输出清单与 pre-s2 快照（只复制，不改仓库）。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'd:\\code\\opensource\\uv';
const BASE = 'd:\\code\\_annot_baseline\\uv-rework';

const PLAN = {
  K1: {
    theme: '并发与内存序 + 持久化崩溃窗口（前半）',
    files: [
      'crates/uv-torch/src/backend.rs',
      'crates/uv-keyring/src/lib.rs',
      'crates/uv-keyring/src/windows.rs',
      'crates/uv-keyring/src/secret_service.rs',
      'crates/uv-keyring/src/macos.rs',
      'crates/uv-keyring/src/blocking.rs',
      'crates/uv-fs/src/locked_file.rs',
      'crates/uv-client/src/cached_client.rs',
      'crates/uv-cache/src/lib.rs',
      'crates/uv-virtualenv/src/virtualenv.rs',
      'crates/uv-installer/src/preparer.rs',
      'crates/uv-fs/src/lib.rs',
      'crates/uv-fs/src/link.rs',
      'crates/uv-fs/src/named_temp_file.rs',
      'crates/uv-fs/src/cachedir.rs',
    ],
  },
  K2: {
    theme: '持久化崩溃窗口（后半）+ 资源生命周期',
    files: [
      'crates/uv-cache/src/archive.rs',
      'crates/uv-cache/src/wheel.rs',
      'crates/uv-cache/src/removal.rs',
      'crates/uv-cache-info/src/cache_info.rs',
      'crates/uv-cache-info/src/git_info.rs',
      'crates/uv-bin-install/src/lib.rs',
      'crates/uv-install-wheel/src/uninstall.rs',
      'crates/uv-installer/src/plan.rs',
      'crates/uv-installer/src/installer.rs',
      'crates/uv-distribution/src/source/mod.rs',
      'crates/uv-distribution/src/source/validated_archive.rs',
      'crates/uv-python-managed/src/downloads.rs',
      'crates/uv-extract/src/lib.rs',
      'crates/uv-extract/src/stream.rs',
      'crates/uv-extract/src/archive_path.rs',
    ],
  },
  K3: {
    theme: '协议状态机 + HTTP 缓存',
    files: [
      'crates/uv-client/src/registry_client.rs',
      'crates/uv-client/src/base_client.rs',
      'crates/uv-client/src/retry.rs',
      'crates/uv-client/src/middleware.rs',
      'crates/uv-client/src/error.rs',
      'crates/uv-client/src/linehaul.rs',
      'crates/uv-client/src/tls.rs',
      'crates/uv-client/src/html.rs',
      'crates/uv-auth/src/middleware.rs',
      'crates/uv-auth/src/realm.rs',
      'crates/uv-auth/src/providers.rs',
      'crates/uv-auth/src/service.rs',
      'crates/uv-auth/src/cache.rs',
      'crates/uv-auth/src/index.rs',
      'crates/uv-distribution-types/src/status_code_strategy.rs',
    ],
  },
  K4: {
    theme: '安全边界：凭据、脱敏、路径校验',
    files: [
      'crates/uv-auth/src/credentials.rs',
      'crates/uv-auth/src/store.rs',
      'crates/uv-auth/src/keyring.rs',
      'crates/uv-redacted/src/policy.rs',
      'crates/uv-redacted/src/lib.rs',
      'crates/uv-netrc/src/netrc.rs',
      'crates/uv-publish/src/trusted_publishing.rs',
      'crates/uv-configuration/src/trusted_host.rs',
      'crates/uv-globfilter/src/glob_dir_filter.rs',
      'crates/uv-install-wheel/src/wheel.rs',
      'crates/uv-install-wheel/src/script.rs',
      'crates/uv-trampoline-builder/src/lib.rs',
      'crates/uv-installer/src/site_packages.rs',
      'crates/uv-installer/src/uninstall.rs',
      'crates/uv-distribution/src/source/built_wheel_metadata.rs',
    ],
  },
  K5: {
    theme: '核心算法：PEP 440 / PEP 508 / marker',
    files: [
      'crates/uv-pep440/src/version.rs',
      'crates/uv-pep440/src/version_specifier.rs',
      'crates/uv-pep440/src/version_ranges.rs',
      'crates/uv-pep508/src/lib.rs',
      'crates/uv-pep508/src/marker/tree.rs',
      'crates/uv-pep508/src/marker/parse.rs',
      'crates/uv-pep508/src/marker/simplify.rs',
      'crates/uv-pep508/src/marker/algebra.rs',
      'crates/uv-pep508/src/verbatim_url.rs',
      'crates/uv-normalize/src/package_name.rs',
      'crates/uv-normalize/src/extra_name.rs',
      'crates/uv-macros/src/deserialize_untagged.rs',
      'crates/uv-distribution-filename/src/egg.rs',
      'crates/uv-distribution-filename/src/source_dist.rs',
      'crates/uv-distribution-filename/src/wheel.rs',
    ],
  },
  K6: {
    theme: '核心算法：PubGrub 求解与平台标签',
    files: [
      'crates/uv-resolver/src/pubgrub/range.rs',
      'crates/uv-resolver/src/pubgrub/package.rs',
      'crates/uv-resolver/src/pubgrub/dependencies.rs',
      'crates/uv-resolver/src/pubgrub/priority.rs',
      'crates/uv-resolver/src/pubgrub/report.rs',
      'crates/uv-resolver/src/resolver/mod.rs',
      'crates/uv-resolver/src/resolver/provider.rs',
      'crates/uv-resolver/src/version_map.rs',
      'crates/uv-resolver/src/candidate_selector.rs',
      'crates/uv-resolver/src/marker.rs',
      'crates/uv-resolver/src/preferences.rs',
      'crates/uv-platform-tags/src/tags.rs',
      'crates/uv-platform-tags/src/platform_tag.rs',
      'crates/uv-platform-tags/src/abi_tag.rs',
      'crates/uv-platform-tags/src/language_tag.rs',
      'crates/uv-platform-tags/src/platform.rs',
    ],
  },
  K7: {
    theme: '序列化兼容层：锁文件与 PyPI 类型',
    files: [
      'crates/uv-lock/src/lock/mod.rs',
      'crates/uv-lock/src/lock/deserialize.rs',
      'crates/uv-lock/src/lock/serialize.rs',
      'crates/uv-lock/src/lock/installable.rs',
      'crates/uv-lock/src/lock/tree.rs',
      'crates/uv-lock/src/lock/export/metadata.rs',
      'crates/uv-lock/src/lock/export/pylock_toml.rs',
      'crates/uv-pypi-types/src/metadata/metadata23.rs',
      'crates/uv-pypi-types/src/metadata/metadata_resolver.rs',
      'crates/uv-pypi-types/src/metadata/pyproject_toml.rs',
      'crates/uv-pypi-types/src/lenient_requirement.rs',
      'crates/uv-pypi-types/src/direct_url.rs',
      'crates/uv-pypi-types/src/identifier.rs',
      'crates/uv-pypi-types/src/simple_json.rs',
      'crates/uv-pypi-types/src/conflicts.rs',
      'crates/uv-pypi-types/src/supported_environments.rs',
    ],
  },
  K8: {
    theme: '序列化兼容层：构建后端与工作区 + 跨函数不变量',
    files: [
      'crates/uv-build-backend/src/metadata.rs',
      'crates/uv-build-backend/src/wheel.rs',
      'crates/uv-build-backend/src/lib.rs',
      'crates/uv-build-backend/src/serde_verbatim.rs',
      'crates/uv-distribution-types/src/variants_json.rs',
      'crates/uv-distribution-types/src/index.rs',
      'crates/uv-workspace/src/pyproject.rs',
      'crates/uv-settings/src/settings.rs',
      'crates/uv-lock-operations/src/validated_lock.rs',
      'crates/uv-lock-operations/src/lock.rs',
      'crates/uv-python-discovery/src/lib.rs',
      'crates/uv-python-discovery/src/discovery.rs',
      'crates/uv-python-discovery/src/project.rs',
      'crates/uv-workspace/src/workspace.rs',
      'crates/uv-project-edit/src/lib.rs',
      'crates/uv-environment-operations/src/install_target.rs',
    ],
  },
};

fs.mkdirSync(path.join(BASE, 'pre-s2'), { recursive: true });
const manifest = [];
const batches = {};
for (const [name, plan] of Object.entries(PLAN)) {
  const files = [];
  for (const rel of plan.files) {
    const abs = path.join(REPO, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) {
      console.error(`MISSING ${name} ${rel}`);
      continue;
    }
    const dst = path.join(BASE, 'pre-s2', rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    files.push(rel);
    manifest.push(rel);
  }
  batches[name] = { theme: plan.theme, files };
}
fs.writeFileSync(path.join(BASE, 'uv-rw-key-batches.json'), JSON.stringify(batches, null, 2));
fs.writeFileSync(path.join(BASE, 'pre-s2', '_files.txt'), manifest.join('\n') + '\n');
const uni = [...new Set(manifest)];
console.log(`batches=${Object.keys(batches).length} files=${uni.length} duplicates=${manifest.length - uni.length}`);
for (const [k, v] of Object.entries(batches)) console.log(`${k}\t${v.files.length}\t${v.theme}`);

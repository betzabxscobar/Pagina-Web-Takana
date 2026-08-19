import path from "node:path";

export const distributionExtensions = Object.freeze([
  ".exe", ".msi", ".msix", ".appx",
  ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz",
  ".apk", ".aab",
  ".appimage", ".deb", ".rpm", ".run", ".bin",
  ".dmg", ".pkg",
  ".jar",
]);

const extensionSet = new Set(distributionExtensions);

export function distributionExtension(filename) {
  return path.extname(path.basename(String(filename || ""))).toLowerCase();
}

export function isSupportedDistributionFile(filename) {
  return extensionSet.has(distributionExtension(filename));
}


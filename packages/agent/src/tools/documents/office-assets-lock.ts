/** Fixed upstream release, verified against GitHub release asset digests. Not an updater. */
export const officeVersion = '1.0.160';
export const officeCommit = 'c56512c8c7b76fe284f09940e4cd492470099d3e';
export const officeReleaseBase = `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${officeVersion}/`;
export const officeBinaryAssets: Record<string, { name: string; sha256: string }> = {
  'linux-x64': {
    name: 'officecli-linux-x64',
    sha256: 'baa084b64ec634bd9d41a0592db3ed85f11658b358bab898679537ea7f3e73a9',
  },
  'linux-arm64': {
    name: 'officecli-linux-arm64',
    sha256: 'e8f06aff6c59f11a73a1a1218bda3ce170299201fd56bce6d62ecd4d0c024e53',
  },
  'darwin-x64': {
    name: 'officecli-mac-x64',
    sha256: '55b27f6d422f9e0bcd2aa40abb262606110ff957a4a5253db7a8ba0460cd81c7',
  },
  'darwin-arm64': {
    name: 'officecli-mac-arm64',
    sha256: 'fe2b31c6c27534dfbbf155386b6b9105420f9315bbb606335ec61490d171386d',
  },
  'win32-x64': {
    name: 'officecli-win-x64.exe',
    sha256: 'c590ca9d464f2b03362825b0f2615efcae33ce3fc0edaeeef29f7ddacb4c5424',
  },
  // Upstream existence does not qualify Kite's Windows ARM64 adapter.
  'win32-arm64': {
    name: 'officecli-win-arm64.exe',
    sha256: '65129df43a4eb8199f3ebf6b17b56c5311242f53c5f725f60efb0a94f8952d74',
  },
};
export const officeFontAsset = {
  url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf',
  sha256: 'd68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964',
};

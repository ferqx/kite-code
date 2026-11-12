#pragma once

#include <string>

std::wstring installationLocation(std::wstring location);
struct SetupSelection {
  std::wstring location;
  bool upgrade = false;
  bool desktopShortcut = true;
};
bool selectInstallationLocation(SetupSelection& selection);

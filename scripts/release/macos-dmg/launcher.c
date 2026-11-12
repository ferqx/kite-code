#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    char location[PATH_MAX], executable[PATH_MAX], app[PATH_MAX];
    uint32_t location_size = sizeof(location);
    if (_NSGetExecutablePath(location, &location_size) != 0 || !realpath(location, executable)) {
        fputs("Could not locate Kite Desktop.\n", stderr);
        return 1;
    }
    char *name = strrchr(executable, '/');
    if (!name) return 1;
    *name = '\0';
    char electron[PATH_MAX];
    int electron_length = snprintf(electron, sizeof(electron),
        "%s/../Resources/native/electron/Electron.app/Contents/MacOS/Electron", executable);
    int app_length = snprintf(app, sizeof(app), "%s/../Resources/native/app", executable);
    if (electron_length < 0 || electron_length >= (int)sizeof(electron) ||
        app_length < 0 || app_length >= (int)sizeof(app)) return 1;

    char canonical_electron[PATH_MAX], canonical_app[PATH_MAX];
    if (!realpath(electron, canonical_electron) || !realpath(app, canonical_app)) {
        fputs("Could not locate the bundled Kite runtime.\n", stderr);
        return 1;
    }
    char **arguments = calloc((size_t)argc + 2, sizeof(*arguments));
    if (!arguments) return 1;
    arguments[0] = canonical_electron;
    arguments[1] = canonical_app;
    for (int index = 1; index < argc; index++) arguments[index + 1] = argv[index];
    unsetenv("NODE_PATH");
    unsetenv("NODE_OPTIONS");
    unsetenv("BUN_OPTIONS");
    unsetenv("ELECTRON_RUN_AS_NODE");
    execv(canonical_electron, arguments);
    perror("Could not start Kite Desktop");
    return 1;
}

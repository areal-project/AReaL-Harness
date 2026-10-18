#define _GNU_SOURCE
#define PY_SSIZE_T_CLEAN
#include <Python.h>

#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static const char *const denied_events[] = {
    "os.exec",
    "os.fork",
    "os.forkpty",
    "os.posix_spawn",
    "os.spawn",
    "os.system",
    "subprocess.Popen",
};

static const char *const denied_modules[] = {
    "ctypes",
    "_ctypes",
    "subprocess",
    "_posixsubprocess",
};

static int starts_with(const char *value, const char *prefix) {
    return strncmp(value, prefix, strlen(prefix)) == 0;
}

static int audit_hook(const char *event, PyObject *arguments, void *unused) {
    (void)unused;
    if (strcmp(event, "import") == 0 && PyTuple_Check(arguments) && PyTuple_GET_SIZE(arguments) > 0) {
        PyObject *name_object = PyTuple_GET_ITEM(arguments, 0);
        if (PyUnicode_Check(name_object)) {
            const char *name = PyUnicode_AsUTF8(name_object);
            if (name == NULL) return -1;
            for (size_t index = 0; index < sizeof(denied_modules) / sizeof(denied_modules[0]); index++) {
                if (strcmp(name, denied_modules[index]) == 0) {
                    PyErr_Format(PyExc_ModuleNotFoundError, "candidate module unavailable: %s", name);
                    return -1;
                }
            }
        }
    }
    for (size_t index = 0; index < sizeof(denied_events) / sizeof(denied_events[0]); index++) {
        if (starts_with(event, denied_events[index])) {
            PyErr_Format(PyExc_PermissionError, "candidate process creation denied: %s", event);
            return -1;
        }
    }
    return 0;
}

static void fail_python(const char *message) {
    fprintf(stderr, "%s\n", message);
    if (PyErr_Occurred()) PyErr_Print();
    Py_FinalizeEx();
    exit(2);
}

static void establish_candidate_boundary(void) {
    struct rlimit data_limit = {128U * 1024U * 1024U, 128U * 1024U * 1024U};
    if (setrlimit(RLIMIT_DATA, &data_limit) != 0) {
        perror("setrlimit RLIMIT_DATA");
        exit(2);
    }
    if (close_range(3, ~0U, 0) != 0 && errno != ENOSYS) {
        perror("close_range");
        exit(2);
    }
    const char *const removable_paths[] = {
        "/trusted/candidate_launcher",
        "/runtime/bin/python3.11",
        "/runtime/loader/ld-linux-x86-64.so.2",
        "/runtime/vendor/libpython3.11.so.1.0",
    };
    for (size_t index = 0; index < sizeof(removable_paths) / sizeof(removable_paths[0]); index++) {
        if (unlink(removable_paths[index]) != 0 && errno != ENOENT) {
            perror(removable_paths[index]);
            exit(2);
        }
    }
    if (rmdir("/trusted") != 0) {
        perror("/trusted");
        exit(2);
    }
    if (clearenv() != 0 || setenv("LC_ALL", "C.UTF-8", 1) != 0 ||
        setenv("PATH", "/nonexistent", 1) != 0) {
        perror("candidate environment");
        exit(2);
    }
    if (setgroups(0, NULL) != 0 || setgid(65534) != 0 || setuid(65534) != 0) {
        perror("drop candidate privileges");
        exit(2);
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "candidate launcher requires a source path\n");
        return 2;
    }

    PyStatus status;
    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    config.site_import = 0;
    config.user_site_directory = 0;
    config.use_environment = 0;
    config.write_bytecode = 0;
    status = PyConfig_SetString(&config, &config.program_name, L"/trusted/candidate_launcher");
    if (PyStatus_Exception(status)) Py_ExitStatusException(status);
    status = PyConfig_SetString(&config, &config.executable, L"/trusted/candidate_launcher");
    if (PyStatus_Exception(status)) Py_ExitStatusException(status);
    status = PyConfig_SetString(&config, &config.base_executable, L"/trusted/candidate_launcher");
    if (PyStatus_Exception(status)) Py_ExitStatusException(status);
    status = PyConfig_SetBytesArgv(&config, argc - 1, argv + 1);
    if (PyStatus_Exception(status)) Py_ExitStatusException(status);
    status = Py_InitializeFromConfig(&config);
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) Py_ExitStatusException(status);

    if (PySys_AddAuditHook(audit_hook, NULL) != 0) fail_python("cannot install evaluator audit hook");
    establish_candidate_boundary();

    FILE *source = fopen(argv[1], "rb");
    if (source == NULL) {
        fprintf(stderr, "%s: %s\n", argv[1], strerror(errno));
        Py_FinalizeEx();
        return 2;
    }
    int result = PyRun_SimpleFileExFlags(source, argv[1], 1, NULL);
    if (result != 0 && PyErr_Occurred()) PyErr_Print();
    if (Py_FinalizeEx() < 0) return 120;
    return result == 0 ? 0 : 1;
}

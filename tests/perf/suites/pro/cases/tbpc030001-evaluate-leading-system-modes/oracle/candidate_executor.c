#include <Python.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define MAX_PACKET (1 << 20)
#define MAX_FDS 2

static PyObject *array_type;
static PyObject *array_constructor;
static PyObject *array_dtype;
static PyObject *isfinite_function;
static PyObject *candidate_function;

static void fail_python(const char *message) {
    fprintf(stderr, "%s\n", message);
    if (PyErr_Occurred()) PyErr_Print();
    exit(2);
}

static char *read_file(const char *path) {
    FILE *stream = fopen(path, "rb");
    if (!stream) { perror(path); exit(2); }
    if (fseek(stream, 0, SEEK_END) || ftell(stream) < 0) exit(2);
    long size = ftell(stream);
    rewind(stream);
    char *data = malloc((size_t)size + 1);
    if (!data || fread(data, 1, (size_t)size, stream) != (size_t)size) exit(2);
    data[size] = '\0';
    fclose(stream);
    return data;
}

static long parse_number(const char *packet, const char *key) {
    const char *cursor = strstr(packet, key);
    if (!cursor || !(cursor = strchr(cursor, ':'))) exit(2);
    cursor++;
    while (*cursor == ' ') cursor++;
    char *end = NULL;
    long value = strtol(cursor, &end, 10);
    if (end == cursor) exit(2);
    return value;
}

static void parse_shape(const char *packet, long shape[3]) {
    const char *cursor = strstr(packet, "\"shape\"");
    if (!cursor || !(cursor = strchr(cursor, '['))) exit(2);
    for (int i = 0; i < 3; i++) {
        cursor++;
        while (*cursor == ' ') cursor++;
        char *end = NULL;
        shape[i] = strtol(cursor, &end, 10);
        if (end == cursor || shape[i] < 1) exit(2);
        cursor = end;
    }
}

static void parse_callback(const char *packet, char output[65]) {
    const char *cursor = strstr(packet, "\"callback\"");
    if (!cursor || !(cursor = strchr(cursor, ':'))) exit(2);
    cursor++;
    while (*cursor == ' ' || *cursor == '\"') cursor++;
    size_t length = 0;
    while (length < 64 && ((cursor[length] >= '0' && cursor[length] <= '9') ||
                           (cursor[length] >= 'a' && cursor[length] <= 'f'))) length++;
    if (length != 32) exit(2);
    memcpy(output, cursor, length);
    output[length] = '\0';
}

static int receive_command(int socket_fd, char packet[MAX_PACKET], int fds[MAX_FDS]) {
    char control[CMSG_SPACE(sizeof(int) * MAX_FDS)] = {0};
    struct iovec iov = {.iov_base = packet, .iov_len = MAX_PACKET - 1};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control)};
    ssize_t count = recvmsg(socket_fd, &message, 0);
    if (count <= 0) exit(2);
    packet[count] = '\0';
    int found = 0;
    for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
        if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
            int available = (int)((header->cmsg_len - CMSG_LEN(0)) / sizeof(int));
            if (available > MAX_FDS) available = MAX_FDS;
            memcpy(fds, CMSG_DATA(header), (size_t)available * sizeof(int));
            found = available;
        }
    }
    return found;
}

static int accept_callback(const char *token) {
    int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (listener < 0) exit(2);
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    address.sun_path[0] = '\0';
    int written = snprintf(address.sun_path + 1, sizeof(address.sun_path) - 1, "tbpc002009-%s", token);
    if (written < 0 || (size_t)written >= sizeof(address.sun_path) - 1) exit(2);
    socklen_t length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + written);
    if (bind(listener, (struct sockaddr *)&address, length) || listen(listener, 1)) { perror("bind callback"); exit(2); }
    int accepted = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    close(listener);
    if (accepted < 0) { perror("accept callback"); exit(2); }
    return accepted;
}

static char *base64_encode(const unsigned char *input, size_t length) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t output_length = 4 * ((length + 2) / 3);
    char *output = malloc(output_length + 1);
    if (!output) exit(2);
    size_t i = 0, j = 0;
    while (i < length) {
        uint32_t a = i < length ? input[i++] : 0;
        uint32_t b = i < length ? input[i++] : 0;
        uint32_t c = i < length ? input[i++] : 0;
        uint32_t value = (a << 16) | (b << 8) | c;
        output[j++] = alphabet[(value >> 18) & 63];
        output[j++] = alphabet[(value >> 12) & 63];
        output[j++] = alphabet[(value >> 6) & 63];
        output[j++] = alphabet[value & 63];
    }
    if (length % 3) output[output_length - 1] = '=';
    if (length % 3 == 1) output[output_length - 2] = '=';
    output[output_length] = '\0';
    return output;
}

static bool attribute_equals(PyObject *object, const char *name, PyObject *expected) {
    PyObject *actual = PyObject_GetAttrString(object, name);
    if (!actual) { PyErr_Clear(); return false; }
    int equal = PyObject_RichCompareBool(actual, expected, Py_EQ);
    Py_DECREF(actual);
    if (equal < 0) { PyErr_Clear(); return false; }
    return equal == 1;
}

static bool is_c_contiguous(PyObject *object) {
    PyObject *flags = PyObject_GetAttrString(object, "flags");
    if (!flags) { PyErr_Clear(); return false; }
    PyObject *value = PyObject_GetAttrString(flags, "c_contiguous");
    Py_DECREF(flags);
    if (!value) { PyErr_Clear(); return false; }
    int truth = PyObject_IsTrue(value);
    Py_DECREF(value);
    if (truth < 0) { PyErr_Clear(); return false; }
    return truth == 1;
}

static bool is_finite(PyObject *object) {
    PyObject *finite = PyObject_CallOneArg(isfinite_function, object);
    if (!finite) { PyErr_Clear(); return false; }
    PyObject *all = PyObject_CallMethod(finite, "all", NULL);
    Py_DECREF(finite);
    if (!all) { PyErr_Clear(); return false; }
    int truth = PyObject_IsTrue(all);
    Py_DECREF(all);
    if (truth < 0) { PyErr_Clear(); return false; }
    return truth == 1;
}

struct checked_array {
    bool exact_type;
    bool dtype;
    bool shape;
    bool contiguous;
    bool finite;
    Py_buffer buffer;
    bool has_buffer;
};

static struct checked_array check_array(PyObject *object, long first, long second) {
    struct checked_array result = {0};
    result.exact_type = Py_TYPE(object) == (PyTypeObject *)array_type;
    if (!result.exact_type) return result;
    result.dtype = attribute_equals(object, "dtype", array_dtype);
    PyObject *shape = second < 0 ? Py_BuildValue("(l)", first) : Py_BuildValue("(ll)", first, second);
    result.shape = shape && attribute_equals(object, "shape", shape);
    Py_XDECREF(shape);
    result.contiguous = is_c_contiguous(object);
    result.finite = is_finite(object);
    if (PyObject_GetBuffer(object, &result.buffer, PyBUF_FULL_RO) == 0) result.has_buffer = true;
    else PyErr_Clear();
    return result;
}

static PyObject *make_array(void *mapping, long shape[3]) {
    PyObject *memory = PyMemoryView_FromMemory(mapping, (Py_ssize_t)(shape[0] * shape[1] * shape[2] *
#ifdef STRUCTURAL
        sizeof(double)
#else
        sizeof(double) * 2
#endif
    ), PyBUF_WRITE);
    PyObject *dimensions = Py_BuildValue("(lll)", shape[0], shape[1], shape[2]);
    PyObject *args = PyTuple_Pack(1, dimensions);
    PyObject *keywords = Py_BuildValue("{s:O,s:O}", "dtype", array_dtype, "buffer", memory);
    PyObject *result = PyObject_Call(array_constructor, args, keywords);
    Py_DECREF(keywords); Py_DECREF(args); Py_DECREF(dimensions); Py_DECREF(memory);
    if (!result) fail_python("cannot construct input array");
    return result;
}

static void load_python(bool candidate) {
    setenv("OPENBLAS_NUM_THREADS", "1", 1); setenv("OMP_NUM_THREADS", "1", 1);
    setenv("MKL_NUM_THREADS", "1", 1); setenv("NUMEXPR_NUM_THREADS", "1", 1);
    char *source = candidate ? read_file("/app/modes.py") : NULL;
    Py_Initialize();
    if (PyRun_SimpleString("import sys; sys.path[:0]=['/usr/local/lib64/python3.9/site-packages','/usr/local/lib/python3.9/site-packages']") != 0) fail_python("cannot set Python path");
    PyObject *numpy = PyImport_ImportModule("numpy");
    if (!numpy) fail_python("cannot import NumPy");
    array_type = PyObject_GetAttrString(numpy, "ndarray");
    array_constructor = array_type; Py_INCREF(array_constructor);
#ifdef STRUCTURAL
    array_dtype = PyObject_GetAttrString(numpy, "dtype");
    PyObject *dtype_arg = PyUnicode_FromString("float64");
#else
    array_dtype = PyObject_GetAttrString(numpy, "dtype");
    PyObject *dtype_arg = PyUnicode_FromString("complex128");
#endif
    PyObject *normalized_dtype = PyObject_CallOneArg(array_dtype, dtype_arg);
    Py_DECREF(dtype_arg); Py_DECREF(array_dtype); array_dtype = normalized_dtype;
    isfinite_function = PyObject_GetAttrString(numpy, "isfinite");
    Py_DECREF(numpy);
    if (!array_type || !array_dtype || !isfinite_function) fail_python("cannot bind NumPy contract");

    if (candidate) {
        const char *allow_fork_control = getenv("TB_TEST_ALLOW_FORK_CONTROL");
        if (!allow_fork_control || strcmp(allow_fork_control, "1") != 0) {
            struct rlimit one = {1, 1};
            if (setrlimit(RLIMIT_NPROC, &one)) { perror("setrlimit"); exit(2); }
        }
        if (setgroups(0, NULL) || setgid(65534) || setuid(65534)) { perror("drop privileges"); exit(2); }
    }
    PyObject *globals = PyDict_New();
    PyDict_SetItemString(globals, "__builtins__", PyEval_GetBuiltins());
    PyDict_SetItemString(globals, "__name__", PyUnicode_FromString(candidate ? "submitted_modes" : "trusted_reference"));
    PyDict_SetItemString(globals, "__file__", PyUnicode_FromString(candidate ? "/app/modes.py" : "<trusted-reference>"));
#ifdef STRUCTURAL
    const char *reference_source =
        "import numpy as np\n"
        "def lowest_modes(stiffnesses,masses):\n"
        " values=[]; vectors=[]\n"
        " for stiffness,mass in zip(stiffnesses,masses):\n"
        "  current_values,current_vectors=np.linalg.eig(np.linalg.solve(mass,stiffness)); selected=int(np.argmin(current_values.real)); vector=current_vectors[:,selected].real; vector/=np.sqrt(vector@mass@vector); values.append(current_values[selected].real); vectors.append(vector)\n"
        " return np.asarray(values),np.asarray(vectors)\n";
    const char *function_name = "lowest_modes";
#else
    const char *reference_source =
        "import numpy as np\n"
        "def dominant_modes(matrices):\n"
        " values=[]; vectors=[]\n"
        " for matrix in matrices:\n"
        "  np.linalg.eigvals(matrix); current_values,current_vectors=np.linalg.eig(matrix); selected=int(np.argmax(np.abs(current_values))); values.append(current_values[selected]); vectors.append(current_vectors[:,selected])\n"
        " return np.asarray(values),np.asarray(vectors)\n";
    const char *function_name = "dominant_modes";
#endif
    PyObject *code = Py_CompileString(candidate ? source : reference_source, candidate ? "/app/modes.py" : "<trusted-reference>", Py_file_input);
    free(source);
    if (!code) fail_python("cannot compile function");
    PyObject *executed = PyEval_EvalCode(code, globals, globals);
    Py_DECREF(code);
    if (!executed) fail_python("cannot load function");
    Py_DECREF(executed);
    candidate_function = PyDict_GetItemString(globals, function_name);
    if (!candidate_function || !PyCallable_Check(candidate_function)) fail_python("required function missing");
    Py_INCREF(candidate_function); Py_DECREF(globals);
}

static char *build_result(long index, PyObject *returned, long shape[3], bool inputs_layout_ok) {
    PyObject *sequence = PySequence_Fast(returned, "return value must contain two arrays");
    PyObject *values = NULL, *vectors = NULL;
    if (sequence && PySequence_Fast_GET_SIZE(sequence) == 2) {
        values = PySequence_Fast_GET_ITEM(sequence, 0);
        vectors = PySequence_Fast_GET_ITEM(sequence, 1);
    } else PyErr_Clear();
    struct checked_array value_check = values ? check_array(values, shape[0], -1) : (struct checked_array){0};
    struct checked_array vector_check = vectors ? check_array(vectors, shape[0], shape[1]) : (struct checked_array){0};
    unsigned char *value_bytes = value_check.has_buffer ? malloc((size_t)value_check.buffer.len) : NULL;
    unsigned char *vector_bytes = vector_check.has_buffer ? malloc((size_t)vector_check.buffer.len) : NULL;
    if (value_check.has_buffer && PyBuffer_ToContiguous(value_bytes, &value_check.buffer, value_check.buffer.len, 'C')) fail_python("cannot copy values");
    if (vector_check.has_buffer && PyBuffer_ToContiguous(vector_bytes, &vector_check.buffer, vector_check.buffer.len, 'C')) fail_python("cannot copy vectors");
    char *values64 = value_check.has_buffer ? base64_encode(value_bytes, (size_t)value_check.buffer.len) : strdup("");
    char *vectors64 = vector_check.has_buffer ? base64_encode(vector_bytes, (size_t)vector_check.buffer.len) : strdup("");
    const char *dtype =
#ifdef STRUCTURAL
        "<f8";
#else
        "<c16";
#endif
    size_t capacity = strlen(values64) + strlen(vectors64) + 2048;
    char *packet = malloc(capacity);
    char values_shape[64], vectors_shape[64];
    snprintf(values_shape, sizeof(values_shape), value_check.shape ? "[%ld]" : "[]", shape[0]);
    snprintf(vectors_shape, sizeof(vectors_shape), vector_check.shape ? "[%ld,%ld]" : "[]", shape[0], shape[1]);
#ifdef STRUCTURAL
    int count = snprintf(packet, capacity,
        "{\"phase\":\"result\",\"index\":%ld,\"metadata\":{\"values_type\":%s,\"vectors_type\":%s,\"values_dtype\":\"%s\",\"vectors_dtype\":\"%s\",\"values_shape\":%s,\"vectors_shape\":%s,\"values_c\":%s,\"vectors_c\":%s,\"finite\":%s,\"stiffness_layout_unchanged\":%s,\"mass_layout_unchanged\":%s},\"values\":\"%s\",\"vectors\":\"%s\"}",
        index, value_check.exact_type?"true":"false", vector_check.exact_type?"true":"false", value_check.dtype?dtype:"", vector_check.dtype?dtype:"", values_shape, vectors_shape, value_check.contiguous?"true":"false", vector_check.contiguous?"true":"false", (value_check.finite&&vector_check.finite)?"true":"false", inputs_layout_ok?"true":"false", inputs_layout_ok?"true":"false", values64, vectors64);
#else
    int count = snprintf(packet, capacity,
        "{\"phase\":\"result\",\"index\":%ld,\"metadata\":{\"values_type\":%s,\"vectors_type\":%s,\"values_dtype\":\"%s\",\"vectors_dtype\":\"%s\",\"values_shape\":%s,\"vectors_shape\":%s,\"values_c\":%s,\"vectors_c\":%s,\"finite\":%s,\"input_layout_unchanged\":%s},\"values\":\"%s\",\"vectors\":\"%s\"}",
        index, value_check.exact_type?"true":"false", vector_check.exact_type?"true":"false", value_check.dtype?dtype:"", vector_check.dtype?dtype:"", values_shape, vectors_shape, value_check.contiguous?"true":"false", vector_check.contiguous?"true":"false", (value_check.finite&&vector_check.finite)?"true":"false", inputs_layout_ok?"true":"false", values64, vectors64);
#endif
    if (count < 0 || (size_t)count >= capacity) exit(2);
    if (value_check.has_buffer) PyBuffer_Release(&value_check.buffer);
    if (vector_check.has_buffer) PyBuffer_Release(&vector_check.buffer);
    Py_XDECREF(sequence); free(value_bytes); free(vector_bytes); free(values64); free(vectors64);
    return packet;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    bool candidate = strcmp(argv[1], "candidate") == 0;
    int command_socket = atoi(argv[2]);
    load_python(candidate);
    if (send(command_socket, "{\"phase\":\"ready\"}", 17, 0) != 17) return 2;
    for (;;) {
        char packet[MAX_PACKET], callback[65];
        int fds[MAX_FDS] = {-1, -1};
        int fd_count = receive_command(command_socket, packet, fds);
        if (strstr(packet, "\"phase\": \"stop\"") || strstr(packet, "\"phase\":\"stop\"")) return 0;
        long index = parse_number(packet, "\"index\"");
        long shape[3]; parse_shape(packet, shape); parse_callback(packet, callback);
#ifdef STRUCTURAL
        if (fd_count != 2) return 2;
#else
        if (fd_count != 1) return 2;
#endif
        close(command_socket);
        void *maps[MAX_FDS] = {0}; size_t sizes[MAX_FDS] = {0}; PyObject *inputs[MAX_FDS] = {0};
        PyObject *input_ndims[MAX_FDS] = {0}; PyObject *input_strides[MAX_FDS] = {0};
        for (int i = 0; i < fd_count; i++) {
            struct stat status; if (fstat(fds[i], &status)) return 2; sizes[i] = (size_t)status.st_size;
            maps[i] = mmap(NULL, sizes[i], PROT_READ|PROT_WRITE, MAP_SHARED, fds[i], 0);
            if (maps[i] == MAP_FAILED) return 2;
            inputs[i] = make_array(maps[i], shape);
            input_ndims[i] = PyObject_GetAttrString(inputs[i], "ndim");
            input_strides[i] = PyObject_GetAttrString(inputs[i], "strides");
            if (!input_ndims[i] || !input_strides[i]) fail_python("cannot snapshot input layout");
        }
        PyObject *args =
#ifdef STRUCTURAL
            PyTuple_Pack(2, inputs[0], inputs[1]);
#else
            PyTuple_Pack(1, inputs[0]);
#endif
        PyObject *returned = PyObject_CallObject(candidate_function, args);
        Py_DECREF(args);
        if (!returned) {
            /* Clear all untrusted Python state before exposing the callback. */
            PyErr_Clear();
            for (int i = 0; i < fd_count; i++) {
                Py_DECREF(input_ndims[i]); Py_DECREF(input_strides[i]); Py_DECREF(inputs[i]);
                munmap(maps[i], sizes[i]); close(fds[i]);
            }
            command_socket = accept_callback(callback);
            char error_packet[256];
            int error_size = snprintf(error_packet, sizeof(error_packet),
                "{\"phase\":\"error\",\"index\":%ld,\"error\":\"submitted function raised\"}", index);
            if (error_size < 0 || (size_t)error_size >= sizeof(error_packet) ||
                send(command_socket, error_packet, (size_t)error_size, 0) != error_size) exit(2);
            continue;
        }
        bool layout_ok = true;
        for (int i = 0; i < fd_count; i++) {
            PyObject *expected_shape = Py_BuildValue("(lll)", shape[0], shape[1], shape[2]);
            layout_ok = layout_ok && attribute_equals(inputs[i], "ndim", input_ndims[i]) && attribute_equals(inputs[i], "shape", expected_shape) && attribute_equals(inputs[i], "strides", input_strides[i]) && attribute_equals(inputs[i], "dtype", array_dtype) && is_c_contiguous(inputs[i]);
            Py_DECREF(expected_shape);
        }
        char *result_packet = build_result(index, returned, shape, layout_ok);
        Py_DECREF(returned);
        for (int i = 0; i < fd_count; i++) { Py_DECREF(input_ndims[i]); Py_DECREF(input_strides[i]); Py_DECREF(inputs[i]); munmap(maps[i], sizes[i]); close(fds[i]); }
        command_socket = accept_callback(callback);
        size_t result_size = strlen(result_packet);
        if (send(command_socket, result_packet, result_size, 0) != (ssize_t)result_size) exit(2);
        free(result_packet);
    }
}

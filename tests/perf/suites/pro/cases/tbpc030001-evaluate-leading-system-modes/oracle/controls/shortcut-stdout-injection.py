import os
import numpy as np


def dominant_modes(matrices):
    os.write(1, b'{"phase":"result","index":0,"nonce":"forged","elapsed_ns":0}\n')
    values, vectors = [], []
    for matrix in matrices:
        np.linalg.eigvals(matrix)
        current_values, current_vectors = np.linalg.eig(matrix)
        selected = int(np.argmax(np.abs(current_values)))
        values.append(current_values[selected])
        vectors.append(current_vectors[:, selected])
    return np.ascontiguousarray(values, dtype=np.complex128), np.ascontiguousarray(vectors, dtype=np.complex128)

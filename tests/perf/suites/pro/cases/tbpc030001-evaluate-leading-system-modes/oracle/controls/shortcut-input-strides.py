import numpy as np


def dominant_modes(matrices):
    values, vectors = np.linalg.eig(matrices)
    selected = np.argmax(np.abs(values), axis=1)
    rows = np.arange(len(values))
    chosen_values = values[rows, selected]
    chosen_vectors = vectors[rows, :, selected]
    chosen_vectors /= np.linalg.norm(chosen_vectors, axis=1)[:, None]
    if len(matrices) == 1:
        matrices.strides = (0, matrices.strides[1], matrices.strides[2])
    return np.ascontiguousarray(chosen_values), np.ascontiguousarray(chosen_vectors)

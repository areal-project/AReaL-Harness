import numpy as np


def dominant_modes(matrices):
    values, vectors = np.linalg.eig(matrices)
    selected = np.argmax(np.abs(values), axis=1)
    rows = np.arange(len(values))
    chosen_values = values[rows, selected]
    chosen_vectors = vectors[rows, :, selected]
    chosen_vectors /= np.linalg.norm(chosen_vectors, axis=1)[:, None]
    return (
        np.ascontiguousarray(chosen_values).reshape(1, len(chosen_values)),
        np.ascontiguousarray(chosen_vectors).reshape(-1),
    )

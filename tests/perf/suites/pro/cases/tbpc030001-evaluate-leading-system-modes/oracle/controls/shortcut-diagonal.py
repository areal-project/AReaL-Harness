import numpy as np


def dominant_modes(matrices):
    diagonal = np.diagonal(matrices, axis1=1, axis2=2)
    selected = np.argmax(np.abs(diagonal), axis=1)
    values = diagonal[np.arange(len(matrices)), selected]
    vectors = np.zeros((len(matrices), matrices.shape[1]), dtype=np.complex128)
    vectors[np.arange(len(matrices)), selected] = 1
    return np.ascontiguousarray(values), vectors

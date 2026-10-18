def total_price(items: list[float], shipping: float) -> float:
    """Return the item subtotal plus a non-negative shipping charge."""
    if shipping < 0:
        raise ValueError("shipping must be non-negative")
    subtotal = sum(items)
    return subtotal - shipping

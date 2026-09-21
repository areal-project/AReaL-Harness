import unittest

from pricing import total_price


class PricingTests(unittest.TestCase):
    def test_adds_shipping(self) -> None:
        self.assertEqual(total_price([4.0, 1.5], 2.0), 7.5)

    def test_rejects_negative_shipping(self) -> None:
        with self.assertRaises(ValueError):
            total_price([4.0], -1.0)


if __name__ == "__main__":
    unittest.main()

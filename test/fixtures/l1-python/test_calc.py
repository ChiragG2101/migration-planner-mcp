"""Passing tests. Runnable with `python3 -m unittest` (stdlib, offline) and
with pytest. Gate 7 counts test_* methods and self.assert* / assert calls."""
import unittest

from calc import add


class TestAdd(unittest.TestCase):
    def test_positives(self):
        self.assertEqual(add(1, 2), 3)

    def test_zero(self):
        self.assertEqual(add(5, 0), 5)


def test_negatives():
    assert add(-1, -1) == -2


if __name__ == "__main__":
    unittest.main()

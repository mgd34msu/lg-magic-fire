import unittest
from pointer_source import PointerRecenter


class RecenterTests(unittest.TestCase):
    def test_late_old_coordinates_cannot_become_a_cursor_jump(self):
        p = PointerRecenter((1870, 540), 0)
        self.assertIsNone(p.sample(0, 1880, .05))
        self.assertEqual(p.sample(0, 964, .08), (964, 540))

    def test_both_axes_must_confirm_the_recenter(self):
        p = PointerRecenter((1800, 950), 0)
        self.assertIsNone(p.sample(0, 963, .1))
        self.assertIsNone(p.sample(1, 960, .11))
        self.assertEqual(p.sample(1, 538, .12), (963, 538))

    def test_sleeping_remote_can_confirm_when_it_wakes(self):
        p = PointerRecenter((1800, 540), 0)
        self.assertEqual(p.sample(0, 961, 10), (961, 540))

    def test_failed_warp_rebases_without_crashing_or_injecting_delta(self):
        p = PointerRecenter((1800, 540), 0)
        self.assertEqual(p.sample(0, 1900, 1), (1900, 540))
        self.assertTrue(p.rebased)


if __name__ == '__main__':
    unittest.main()

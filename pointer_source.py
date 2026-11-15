"""Reject queued pre-recenter coordinates without changing Fire pointer motion."""
class PointerRecenter(object):
    center = (960, 540)
    margin = (300, 150)

    def __init__(self, previous, now):
        self.values = list(self.center)
        self.current = list(previous)
        self.rebased = False
        self.seen = [previous[i] == self.center[i] for i in (0, 1)]
        self.deadline = now + .75

    def sample(self, axis, value, now):
        self.current[axis] = value
        if abs(value - self.center[axis]) <= self.margin[axis]:
            self.values[axis] = value
            self.seen[axis] = True
        if all(self.seen):
            return tuple(self.values)
        if now > self.deadline:
            # Discard the uncertain movement instead of restarting the bridge
            # or converting the stale coordinate into a large mouse jump.
            self.rebased = True
            return tuple(self.current)
        return None

from app.preload import pick_preload


def test_preload_four_ends():
    ids = [f"n{i}" for i in range(10)]
    assert pick_preload(ids) == ["n0", "n1", "n8", "n9"]


def test_preload_short_list():
    assert pick_preload(["a", "b"]) == ["a", "b"]

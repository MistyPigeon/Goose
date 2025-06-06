import mozinfo
import mozinstall
import mozunit
import pytest


@pytest.mark.skipif(
    mozinfo.isWin,
    reason="Bug 1157352 - New firefox.exe needed for mozinstall 1.12 and higher.",
)
def test_is_installer(request, get_installer):
    """Test that we can identify a correct installer."""

    assert mozinstall.is_installer(get_installer("tar.xz"))
    assert mozinstall.is_installer(get_installer("zip"))

    if mozinfo.isWin:
        assert mozinstall.is_installer(get_installer("msix"))

        # test exe installer
        assert mozinstall.is_installer(get_installer("exe"))

        try:
            # test stub browser file
            # without pefile on the system this test will fail
            import pefile  # noqa

            stub_exe = (
                request.node.fspath.dirpath("build_stub").join("firefox.exe").strpath
            )
            assert not mozinstall.is_installer(stub_exe)
        except ImportError:
            pass

    if mozinfo.isMac or mozinfo.isLinux:
        assert mozinstall.is_installer(get_installer("dmg"))


if __name__ == "__main__":
    mozunit.main()

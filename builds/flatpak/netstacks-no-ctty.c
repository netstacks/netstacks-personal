/*
 * Used by netstacks-host-shell.sh. The agent's PTY setup makes the wrapper the
 * session leader controlling the terminal, which stops Flatpak's host helper
 * from making the terminal controlling for the real shell. Without that,
 * Ctrl-C and /dev/tty prompts do not work. Release it, then exec the command.
 */
#include <signal.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc < 2)
        return 2;

    /* Releasing the terminal sends SIGHUP to our own foreground group. */
    signal(SIGHUP, SIG_IGN);
    (void)ioctl(STDIN_FILENO, TIOCNOTTY);
    signal(SIGHUP, SIG_DFL);

    execv(argv[1], argv + 1);
    perror(argv[1]);
    return 127;
}

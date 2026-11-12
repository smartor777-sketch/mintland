/*
 * deskwall — минимальный «слой под иконками» для X11 (по мотивам xwinwrap).
 *
 * Отличия от xwinwrap -ov:
 *   - окно КАК РЕБЁНОК ROOT и УПРАВЛЯЕМОЕ WM (не override-redirect):
 *     Muffin сам кладёт окна типа _NET_WM_WINDOW_TYPE_DESKTOP на дно стека;
 *   - skip-taskbar/skip-pager/below + input=False (не фокусируется);
 *   - watchdog: держит окно ровно НИЖЕ окна nemo-desktop (CWSibling);
 *   - форкает команду, подставляя WID, и живёт ровно столько, сколько она.
 *
 * Сборка: cc -O2 -Wall deskwall.c -lX11 -lXext -o deskwall
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/extensions/shape.h>

/* игнорировать X-ошибки (окно nemo может исчезнуть между find и configure) */
static int ignore_xerrors(Display *d, XErrorEvent *e) { return 0; }

/* найти основное окно nemo-desktop (наибольшее видимое с таким res_name) */
static Window find_nemo(Display *d, Window root) {
    Window tr, par, *ch = NULL;
    unsigned int n = 0;
    Window best = 0;
    unsigned int best_area = 0;
    if (!XQueryTree(d, root, &tr, &par, &ch, &n)) return 0;
    for (unsigned int i = 0; i < n; i++) {
        XWindowAttributes at;
        XClassHint cls;
        if (!XGetWindowAttributes(d, ch[i], &at)) continue;
        if (at.map_state != IsViewable || at.width < 200) continue;
        cls.res_name = cls.res_class = NULL;
        if (!XGetClassHint(d, ch[i], &cls)) continue;
        if (cls.res_name && strstr(cls.res_name, "nemo-desktop")) {
            unsigned int area = (unsigned int)at.width * at.height;
            if (area > best_area) { best_area = area; best = ch[i]; }
        }
        if (cls.res_name) XFree(cls.res_name);
        if (cls.res_class) XFree(cls.res_class);
    }
    if (ch) XFree(ch);
    return best;
}

/* поставить наше окно ровно НИЖЕ окна nemo (CWSibling) */
static void restack_below(Display *d, Window win, Window nemo) {
    XWindowChanges xc;
    xc.sibling = nemo;
    xc.stack_mode = Below;
    XConfigureWindow(d, win, CWSibling | CWStackMode, &xc);
    XSync(d, False);
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--create") == 0) {
        /* создать окно (DESKTOP, пониженное) и ждать stdin: окно живёт, пока процесс жив */
        Display *d = XOpenDisplay(NULL);
        if (!d) { fprintf(stderr, "deskwall: cannot open display\n"); return 1; }
        int s = DefaultScreen(d);
        Window root = RootWindow(d, s);
        int w = DisplayWidth(d, s), h = DisplayHeight(d, s);
        XSetWindowAttributes a;
        memset(&a, 0, sizeof a);
        a.override_redirect = False;
        a.event_mask = StructureNotifyMask | ExposureMask;
        Window win = XCreateWindow(d, root, 0, 0, w, h, 0,
                                   CopyFromParent, InputOutput, CopyFromParent,
                                   CWOverrideRedirect | CWEventMask, &a);
        Atom t  = XInternAtom(d, "_NET_WM_WINDOW_TYPE", False);
        Atom dt = XInternAtom(d, "_NET_WM_WINDOW_TYPE_DESKTOP", False);
        XChangeProperty(d, win, t, XA_ATOM, 32, PropModeReplace,
                        (unsigned char *)&dt, 1);
        XMapWindow(d, win);
        XLowerWindow(d, win);
        XSync(d, False);
        fprintf(stdout, "0x%lx\n", (unsigned long)win);
        fflush(stdout);
        /* держим окно живым */
        char buf[64];
        while (fgets(buf, sizeof buf, stdin)) { /* noop */ }
        XDestroyWindow(d, win);
        XCloseDisplay(d);
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "-r") == 0) {
        /* режим разового restack: deskwall -r 0xWINID — поставить окно ниже nemo */
        Display *d = XOpenDisplay(NULL);
        if (!d) return 1;
        Window w = (Window)strtoul(argv[2], NULL, 0);
        XSetErrorHandler(ignore_xerrors);
        Window nemo = find_nemo(d, DefaultRootWindow(d));
        if (nemo) restack_below(d, w, nemo);
        XCloseDisplay(d);
        return 0;
    }
    if (argc < 3 || strcmp(argv[1], "--") != 0) {
        fprintf(stderr, "usage: deskwall -- COMMAND... (WID подставляется)\n"
                        "       deskwall -r 0xWINID (restack ниже nemo-desktop)\n");
        return 1;
    }
    Display *d = XOpenDisplay(NULL);
    if (!d) { fprintf(stderr, "deskwall: cannot open display\n"); return 1; }
    int s = DefaultScreen(d);
    Window root = RootWindow(d, s);
    int w = DisplayWidth(d, s), h = DisplayHeight(d, s);

    XSetWindowAttributes a;
    memset(&a, 0, sizeof a);
    a.override_redirect = False; /* управляемое окно — иначе Muffin поднимает его наверх */
    a.event_mask = StructureNotifyMask | ExposureMask;

    Window win = XCreateWindow(d, root, 0, 0, w, h, 0,
                               CopyFromParent, InputOutput, CopyFromParent,
                               CWOverrideRedirect | CWEventMask, &a);

    /* не фокусируется и не принимает ввод */
    XWMHints *hints = XAllocWMHints();
    hints->flags = InputHint | StateHint;
    hints->input = False;
    hints->initial_state = NormalState;
    XSetWMHints(d, win, hints);
    XFree(hints);

    Atom t  = XInternAtom(d, "_NET_WM_WINDOW_TYPE", False);
    Atom dt = XInternAtom(d, "_NET_WM_WINDOW_TYPE_DESKTOP", False);
    XChangeProperty(d, win, t, XA_ATOM, 32, PropModeReplace,
                    (unsigned char *)&dt, 1);

    /* below + не в панели задач/альт-табе */
    Atom state  = XInternAtom(d, "_NET_WM_STATE", False);
    Atom below  = XInternAtom(d, "_NET_WM_STATE_BELOW", False);
    Atom stask  = XInternAtom(d, "_NET_WM_STATE_SKIP_TASKBAR", False);
    Atom spager = XInternAtom(d, "_NET_WM_STATE_SKIP_PAGER", False);
    Atom slist[3] = { below, stask, spager };
    XChangeProperty(d, win, state, XA_ATOM, 32, PropModeReplace,
                    (unsigned char *)slist, 3);

    /* пустая input-форма: окно никогда не перехватывает мышь */
    XShapeCombineRectangles(d, win, ShapeInput, 0, 0, NULL, 0, ShapeSet, 0);

    XMapWindow(d, win);
    XLowerWindow(d, win);
    XSync(d, False);
    fprintf(stderr, "deskwall: window 0x%lx %dx%d created (managed), lowered\n",
            (unsigned long)win, w, h);

    char wid[32];
    snprintf(wid, sizeof wid, "0x%lx", (unsigned long)win);
    for (int i = 2; i < argc; i++)
        if (strcmp(argv[i], "WID") == 0) argv[i] = wid;

    pid_t p = fork();
    if (p == 0) {
        execvp(argv[2], argv + 2);
        perror("deskwall: exec");
        _exit(127);
    }

    /* watchdog: держать окно ниже nemo-desktop, пока дочерняя команда жива */
    XSetErrorHandler(ignore_xerrors);
    int st;
    for (;;) {
        Window nemo = find_nemo(d, root);
        if (nemo) restack_below(d, win, nemo);
        if (waitpid(p, &st, WNOHANG) == p) break;
        sleep(2);
    }

    XDestroyWindow(d, win);
    XCloseDisplay(d);
    return 0;
}

# Patches guacamole-server's src/protocols/rdp/rdp.c so it builds against
# both FreeRDP <= 3.24 (which exposes `Authenticate`) and FreeRDP >= 3.25
# (which renamed it to `AuthenticateEx` and added an `rdp_auth_reason reason`
# parameter). The selection happens at compile time via the FreeRDP version
# macros, so behaviour on older toolchains is unchanged.
#
# Two transformations:
#   1. The 2-line forward declaration / definition opening of
#      `rdp_freerdp_authenticate` is wrapped in #if/#else/#endif providing
#      the new 5-arg signature when FreeRDP >= 3.25.
#   2. The single-line callback assignment `rdp_inst->Authenticate = ...;`
#      is wrapped to assign to `AuthenticateEx` instead on FreeRDP >= 3.25.

BEGIN {
    sig1 = "static BOOL rdp_freerdp_authenticate(freerdp* instance, char** username,"
    sig2 = "        char** password, char** domain) {"
    assign = "    rdp_inst->Authenticate = rdp_freerdp_authenticate;"
    guard_open = "#if defined(FREERDP_VERSION_MAJOR) && (FREERDP_VERSION_MAJOR > 3 || (FREERDP_VERSION_MAJOR == 3 && FREERDP_VERSION_MINOR >= 25))"
    sig_replaced = 0
    assign_replaced = 0
}

{
    # Function definition: replace the two-line opening signature.
    if (!sig_replaced && $0 == sig1) {
        if ((getline next_line) > 0 && next_line == sig2) {
            print guard_open
            print "static BOOL rdp_freerdp_authenticate(freerdp* instance, char** username,"
            print "        char** password, char** domain, rdp_auth_reason reason) {"
            print "    (void) reason;"
            print "#else"
            print sig1
            print sig2
            print "#endif"
            sig_replaced = 1
            next
        } else {
            # Did not match the expected following line; emit both verbatim.
            print $0
            print next_line
            next
        }
    }

    # Callback assignment: replace the single-line assignment.
    if (!assign_replaced && $0 == assign) {
        print guard_open
        print "    rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;"
        print "#else"
        print assign
        print "#endif"
        assign_replaced = 1
        next
    }

    print $0
}

END {
    if (!sig_replaced) {
        print "ERROR: could not find rdp_freerdp_authenticate signature" > "/dev/stderr"
        exit 1
    }
    if (!assign_replaced) {
        print "ERROR: could not find rdp_inst->Authenticate assignment" > "/dev/stderr"
        exit 1
    }
}

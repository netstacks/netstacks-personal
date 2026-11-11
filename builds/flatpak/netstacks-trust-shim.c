/*
 * Preloaded by netstacks-launcher.sh. WebKit must trust the agent's self-signed
 * https://127.0.0.1 certificate, but the runtime's system trust store is
 * read-only. This adds the app's private anchors directory whenever the system
 * store is loaded, so the certificate is trusted only inside this sandbox.
 * Chain and hostname validation are unchanged.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <gnutls/x509.h>

int gnutls_x509_trust_list_add_system_trust(gnutls_x509_trust_list_t list,
                                            unsigned int tl_flags,
                                            unsigned int tl_vflags)
{
    int (*real)(gnutls_x509_trust_list_t, unsigned int, unsigned int) =
        dlsym(RTLD_NEXT, "gnutls_x509_trust_list_add_system_trust");
    int count = real(list, tl_flags, tl_vflags);
    const char *dir = getenv("NETSTACKS_TRUST_ANCHORS");

    if (count >= 0 && dir != NULL) {
        int added = gnutls_x509_trust_list_add_trust_dir(
            list, dir, NULL, GNUTLS_X509_FMT_PEM, tl_flags, tl_vflags);
        if (added > 0)
            count += added;
    }
    return count;
}

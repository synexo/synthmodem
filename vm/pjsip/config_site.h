/*
 * vm/pjsip/config_site.h — compile-time configuration overrides for PJSIP.
 *
 * scripts/build-vm-binaries.sh copies this file into the extracted
 * PJSIP source tree at pjlib/include/pj/config_site.h before running
 * ./configure. PJSIP's build system uses config_site.h as the single
 * place where consumers inject project-specific #defines ahead of the
 * main config.h.
 *
 * Currently empty, matching what D-Modem ships. All PJSIP behavior
 * relevant to the slmodemd-pjsip backend is configured at runtime
 * through d-modem.c (software clock, fixed jitter buffer, VAD off,
 * EC off, etc.), not through compile-time knobs. If we ever need to
 * override a compile-time default (e.g. PJ_IOQUEUE_MAX_HANDLES,
 * PJ_HAS_IPV6, PJMEDIA_HAS_SRTP), this is the file where that change
 * lives.
 *
 * See pjlib/include/pj/config_site_sample.h inside the PJSIP source
 * tree for the catalog of overridable knobs.
 */

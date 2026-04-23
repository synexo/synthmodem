/*
 *
 *    v8_open_stub.c - minimal open stub for the inferred V.8 engine API.     
 *
 */

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include <modem_defs.h>
#include <modem_debug.h>

#include "v8_open.h"

#define V8OPEN_DBG(fmt,args...) dprintf("v8open: " fmt, ##args)
#define V8OPEN_PCM_AMPLITUDE 10000
#define V8OPEN_V21_BITRATE 300U
#define V8OPEN_ANSAM_FREQ 2100U
#define V8OPEN_ANSAM_AM_FREQ 15U
#define V8OPEN_V21_ANS_MARK 1650U
#define V8OPEN_V21_ANS_SPACE 1850U
#define V8OPEN_V21_ORG_MARK 980U
#define V8OPEN_V21_ORG_SPACE 1180U
#define V8OPEN_ANSAM_REVERSAL_MS 450U
#define V8OPEN_ANSAM_LEADIN_MS 200U
#define V8OPEN_ANSAM_TONE_MS 2500U
#define V8OPEN_ANSAM_SEND_MS (V8OPEN_ANSAM_LEADIN_MS + V8OPEN_ANSAM_TONE_MS)
#define V8OPEN_CI_DETECT_THRESHOLD 600U
#define V8OPEN_CI_DETECT_FRAMES 48U
#define V8OPEN_CI_WAIT_TIMEOUT_MS 3000U
#define V8OPEN_ANSAM_AM_DIVISOR 5U
#define V8OPEN_CM_WAIT_TAIL_MS 2400U
#define V8OPEN_CM_WAIT_TAIL_AFTER_FIRST_VALID_MS 2400U
#define V8OPEN_CJ_WAIT_MS 900U
#define V8OPEN_CJ_ECHO_GUARD_MS 120U
#define V8OPEN_CJ_COLLECT_MIN_MS 420U
#define V8OPEN_CM_TIMEOUT_JM_PROMOTE_MIN_CANDIDATES 200U
#define V8OPEN_CM_COLLECT_WORDS_LONG ((V8OPEN_CM_WORDS * 2U) + 4U)
#define V8OPEN_CM_COLLECT_WORDS_WAIT V8OPEN_CM_WORDS
#define V8OPEN_CM_COLLECT_BURST 2U
#define V8OPEN_CJ_COLLECT_BURST 2U
#define V8OPEN_MAX_SAMPLES_PER_BIT 64U
#define V8OPEN_DEMOD_STAGE_SAMPLES 12U
#define V8OPEN_DEMOD_HISTORY_SAMPLES 40U
#define V8OPEN_CM_STALL_WORDS 8U
#define V8OPEN_CM_EARLY_PROMOTE_STALLS 2U
#define V8OPEN_CM_INVALID_RELOCK_WORDS 12U
#define V8OPEN_CJ_INVALID_RELOCK_WORDS 12U
#define V8OPEN_CM_STAGE2_WAIT_MS 80U
#define V8OPEN_CM_STAGE2_WAIT_CAP_MS 120U
#define V8OPEN_CM_STAGE2_WAIT_LOG_MASK 0x003fU
#define V8OPEN_CM_STAGE1_METRIC_MIN_SEND 0x30U
#define V8OPEN_CM_STAGE1_METRIC_MIN_WAIT 0x18U
#define V8OPEN_CM_STAGE1_RUN_MIN_SEND 0x33U
#define V8OPEN_CM_STAGE1_RUN_MIN_WAIT 0x10U
#define V8OPEN_CM_STAGE2_MONO_BITS_CARRY 96U
#define V8OPEN_CM_STAGE2_MONO_BITS_WAIT 160U
#define V8OPEN_CM_FORCE_COLLECT_HITS 192U
#define V8OPEN_CM_FORCE_COLLECT_BITS 96U
#define V8OPEN_CM_FORCE_COLLECT_REMAIN_MS 280U
#define V8OPEN_CM_FORCE_SUPPRESS_MAX 4U
#define V8OPEN_CM_FORCE_SUPPRESS_REMAIN_MS 220U
#define V8OPEN_CM_ANSAM_PHASE_SCAN_MAX 9U
#define V8OPEN_CM_CONFIRM_IDENTICAL_MIN 2U
#define V8OPEN_AGC_FIR_SAMPLES 40U
#define V8OPEN_AGC_POWER_RING 36U
#define V8OPEN_AGC_BLOCK_SAMPLES 4U
#define V8OPEN_DEMOD_LOCK_TICKS 5U
#define V8OPEN_CM_WORDS 10U
#define V8OPEN_CJ_WORDS 6U
#define V8OPEN_RX_AGC_INIT_GAIN 0x0200U
#define V8OPEN_RX_AGC_RECOVERY_GAIN 0x0400U
#define V8OPEN_RX_AGC_SAT_COUNT_LIMIT 10U
#define V8OPEN_RX_AGC_GAIN_MAX 0x7f00U
#define V8OPEN_RX_AGC_SCALE_SHIFT 10U
#define V8OPEN_RX_AGC_SCALE_SAT_POS 0x7f00
#define V8OPEN_RX_AGC_SCALE_SAT_NEG ((short)0x8100)
#define V8OPEN_RX_AGC_RATE_Q16 0x3333U
#define V8OPEN_RX_AGC_LEVEL_TARGET 0x0fa0U
#define V8OPEN_RX_AGC_LEVEL_WINDOW 0x07d0U
#define V8OPEN_RX_AGC_CONTROL_LIMIT 0x03e8U
#define V8OPEN_RX_AGC_GAIN_DECAY_COEFF 0x390aU
#define V8OPEN_RX_AGC_GAIN_GROW_COEFF 0x47cfU
#define V8OPEN_RX_AGC_GAIN_GROW_LIMIT 0x6a00U
#define V8OPEN_DEMOD_ENERGY_FLOOR 50000

/*
 * 256-entry sine table, amplitude ±10000.
 * sin(2*pi*i/256) * 10000, rounded to nearest integer.
 * Used by v8_open_wave_sample_phase for clean tone generation.
 */
static const short v8_open_sine_256[256] = {
	    0,   245,   491,   736,   980,  1224,  1467,  1710,
	 1951,  2191,  2430,  2667,  2903,  3137,  3369,  3599,
	 3827,  4052,  4276,  4496,  4714,  4929,  5141,  5350,
	 5556,  5758,  5957,  6152,  6344,  6532,  6716,  6895,
	 7071,  7242,  7410,  7572,  7730,  7883,  8032,  8176,
	 8315,  8449,  8577,  8701,  8819,  8932,  9040,  9142,
	 9239,  9330,  9415,  9495,  9569,  9638,  9700,  9757,
	 9808,  9853,  9892,  9925,  9952,  9973,  9988,  9997,
	10000,  9997,  9988,  9973,  9952,  9925,  9892,  9853,
	 9808,  9757,  9700,  9638,  9569,  9495,  9415,  9330,
	 9239,  9142,  9040,  8932,  8819,  8701,  8577,  8449,
	 8315,  8176,  8032,  7883,  7730,  7572,  7410,  7242,
	 7071,  6895,  6716,  6532,  6344,  6152,  5957,  5758,
	 5556,  5350,  5141,  4929,  4714,  4496,  4276,  4052,
	 3827,  3599,  3369,  3137,  2903,  2667,  2430,  2191,
	 1951,  1710,  1467,  1224,   980,   736,   491,   245,
	    0,  -245,  -491,  -736,  -980, -1224, -1467, -1710,
	-1951, -2191, -2430, -2667, -2903, -3137, -3369, -3599,
	-3827, -4052, -4276, -4496, -4714, -4929, -5141, -5350,
	-5556, -5758, -5957, -6152, -6344, -6532, -6716, -6895,
	-7071, -7242, -7410, -7572, -7730, -7883, -8032, -8176,
	-8315, -8449, -8577, -8701, -8819, -8932, -9040, -9142,
	-9239, -9330, -9415, -9495, -9569, -9638, -9700, -9757,
	-9808, -9853, -9892, -9925, -9952, -9973, -9988, -9997,
	-10000, -9997, -9988, -9973, -9952, -9925, -9892, -9853,
	-9808, -9757, -9700, -9638, -9569, -9495, -9415, -9330,
	-9239, -9142, -9040, -8932, -8819, -8701, -8577, -8449,
	-8315, -8176, -8032, -7883, -7730, -7572, -7410, -7242,
	-7071, -6895, -6716, -6532, -6344, -6152, -5957, -5758,
	-5556, -5350, -5141, -4929, -4714, -4496, -4276, -4052,
	-3827, -3599, -3369, -3137, -2903, -2667, -2430, -2191,
	-1951, -1710, -1467, -1224,  -980,  -736,  -491,  -245
};

static const short v8_open_v21_filt_0[40] = {
	0x0000, 0x00a6, 0x0120, 0x010f, 0x0019, 0xfe67, 0xfcf1, 0xfd15,
	0xff85, 0x035e, 0x0643, 0x05c4, 0x0143, 0xfae0, 0xf684, 0xf769,
	0xfdbb, 0x0614, 0x0b6b, 0x0a46, 0x031d, 0xfa29, 0xf4be, 0xf5eb,
	0xfca0, 0x0492, 0x0918, 0x0811, 0x02e3, 0xfd29, 0xfa2b, 0xfaf2,
	0xfe22, 0x0150, 0x02c5, 0x024b, 0x00da, 0xff93, 0xff03, 0xff1b
};

static const short v8_open_v21_filt_1[40] = {
	0x00dc, 0x00aa, 0x0008, 0xff05, 0xfe20, 0xfe2e, 0xffc2, 0x026e,
	0x0492, 0x0446, 0x00d3, 0xfbb2, 0xf80b, 0xf8bf, 0xfe3e, 0x05be,
	0x0aae, 0x09a3, 0x02be, 0xf9e3, 0xf463, 0xf592, 0xfcaa, 0x054e,
	0x0a63, 0x0944, 0x0338, 0xfc48, 0xf87a, 0xf964, 0xfd95, 0x0204,
	0x0432, 0x0390, 0x0152, 0xff39, 0xfe54, 0xfea0, 0xff77, 0x0041
};

static const short v8_open_v21_filt_2[40] = {
	0x0000, 0x008e, 0x0114, 0x015a, 0x0106, 0xffd7, 0xfe02, 0xfc4c,
	0xfbce, 0xfd58, 0x00d3, 0x0505, 0x07f5, 0x07dc, 0x0427, 0xfdfc,
	0xf7e3, 0xf4a8, 0xf5fd, 0xfb92, 0x031d, 0x0963, 0x0bbd, 0x094e,
	0x0360, 0xfcae, 0xf80d, 0xf720, 0xf9bd, 0xfe3b, 0x026b, 0x04ad,
	0x0492, 0x02ca, 0x008f, 0xfeee, 0xfe54, 0xfe94, 0xff3a, 0xffe4
};

static const short v8_open_v21_filt_3[40] = {
	0x00dc, 0x00bf, 0x0052, 0xff80, 0xfe6d, 0xfd95, 0xfdab, 0xff29,
	0x01de, 0x04bf, 0x0643, 0x0527, 0x0143, 0xfbdd, 0xf74b, 0xf5de,
	0xf8b1, 0xfef5, 0x0622, 0x0b1a, 0x0b9d, 0x0766, 0x004f, 0xf96d,
	0xf59d, 0xf637, 0xfa89, 0x0059, 0x0512, 0x06f9, 0x05d5, 0x02c8,
	0xff85, 0xfd6c, 0xfcfc, 0xfdd4, 0xff26, 0x003f, 0x00d1, 0x00ec
};

static const short v8_open_v21_filt_5ac0[40] = {
	0x0000, 0x00df, 0x00be, 0xff52, 0xfe24, 0xff73, 0x028d, 0x0316,
	0xfed0, 0xfa96, 0xfd35, 0x04eb, 0x0772, 0xffb6, 0xf6dd, 0xf972,
	0x0576, 0x0b3e, 0x024a, 0xf5d9, 0xf676, 0x0378, 0x0bb7, 0x04b4,
	0xf847, 0xf697, 0x00a2, 0x0880, 0x04e8, 0xfc34, 0xf9cf, 0xff1d,
	0x03fb, 0x02ef, 0xff04, 0xfd94, 0xff48, 0x010d, 0x0102, 0xffe9
};

static const short v8_open_v21_filt_5b20[40] = {
	0x00dc, 0x0054, 0xff28, 0xfeba, 0x003f, 0x025c, 0x01b4, 0xfdca,
	0xfb90, 0xff77, 0x05aa, 0x0540, 0xfceb, 0xf71f, 0xfce6, 0x07fd,
	0x0975, 0xfe25, 0xf47c, 0xf9b0, 0x0752, 0x0b70, 0x00c5, 0xf59f,
	0xf847, 0x0444, 0x09a0, 0x0294, 0xf99c, 0xf9e4, 0x013b, 0x055e,
	0x024c, 0xfd97, 0xfd18, 0xffec, 0x01bc, 0x00fc, 0xff81, 0xff13
};

static const short v8_open_v21_filt_5b80[40] = {
	0x0000, 0x00d2, 0x00ef, 0xffdc, 0xfe44, 0xfe20, 0x0099, 0x03a2,
	0x0340, 0xfe6c, 0xf9cf, 0xfb70, 0x0315, 0x08d7, 0x055c, 0xfb21,
	0xf515, 0xfaa1, 0x0686, 0x0be5, 0x049a, 0xf86b, 0xf47c, 0xfcb1,
	0x07b9, 0x09e3, 0x01e2, 0xf922, 0xf88e, 0xff4b, 0x0540, 0x04cc,
	0x0000, 0xfca7, 0xfd73, 0x003d, 0x01bc, 0x011d, 0xffc8, 0xff1c
};

static const short v8_open_v21_filt_5be0[40] = {
	0x00dc, 0x0070, 0xff60, 0xfe91, 0xff48, 0x018a, 0x0302, 0x011a,
	0xfcc0, 0xfacb, 0xfec5, 0x0590, 0x0772, 0x00df, 0xf7fb, 0xf6e3,
	0x0000, 0x0a0c, 0x09c3, 0xfed4, 0xf4e4, 0xf6c3, 0x024a, 0x0ae7,
	0x07b9, 0xfd00, 0xf68a, 0xfa5e, 0x0315, 0x0729, 0x0382, 0xfd6f,
	0xfb68, 0xfe36, 0x01b4, 0x0269, 0x00b8, 0xff16, 0xfee6, 0xffbb
};

/* Blob V8agc front-end tables at rodata 0x5420 / 0x5480. */
static const short v8_open_agc_filt_5420[V8OPEN_AGC_FIR_SAMPLES] = {
	0x0019, 0x0006, 0xfff5, 0xfff4, 0x0005, 0x000d, 0xffdb, 0xff64,
	0xfeff, 0xff4b, 0x00a5, 0x028e, 0x03a4, 0x0282, 0xff0b, 0xfafb,
	0xf910, 0xfb1e, 0x007a, 0x0618, 0x087a, 0x0618, 0x007a, 0xfb1e,
	0xf910, 0xfafb, 0xff0b, 0x0282, 0x03a4, 0x028e, 0x00a5, 0xff4b,
	0xfeff, 0xff64, 0xffdb, 0x000d, 0x0005, 0xfff4, 0xfff5, 0x0006
};

static const short v8_open_agc_filt_5480[V8OPEN_AGC_FIR_SAMPLES] = {
	0xfff1, 0x0005, 0x001b, 0x0021, 0x0000, 0xffc2, 0xffa3, 0xffe6,
	0x007a, 0x00da, 0x006c, 0xff3b, 0xfe43, 0xfeca, 0x010e, 0x0376,
	0x034a, 0xfebd, 0xf6ca, 0xef23, 0x2c0f, 0xef23, 0xf6ca, 0xfebd,
	0x034a, 0x0376, 0x010e, 0xfeca, 0xfe43, 0xff3b, 0x006c, 0x00da,
	0x007a, 0xffe6, 0xffa3, 0xffc2, 0x0000, 0x0021, 0x001b, 0x0005
};

/* Blob V8agc metric LUT at rodata 0x54e0 (192 entries). */
static const unsigned short v8_open_agc_metric_lut_54e0[192] = {
	0x4000, 0x407f, 0x40fe, 0x417b, 0x41f8, 0x4273, 0x42ee, 0x4368,
	0x43e1, 0x445a, 0x44d1, 0x4548, 0x45be, 0x4633, 0x46a7, 0x471b,
	0x478d, 0x4800, 0x4871, 0x48e2, 0x4952, 0x49c1, 0x4a30, 0x4a9e,
	0x4b0b, 0x4b78, 0x4be5, 0x4c50, 0x4cbb, 0x4d26, 0x4d90, 0x4df9,
	0x4e62, 0x4eca, 0x4f32, 0x4f99, 0x5000, 0x5066, 0x50cb, 0x5130,
	0x5195, 0x51f9, 0x525d, 0x52c0, 0x5323, 0x5385, 0x53e7, 0x5449,
	0x54a9, 0x550a, 0x556a, 0x55ca, 0x5629, 0x5688, 0x56e6, 0x5745,
	0x57a2, 0x5800, 0x585c, 0x58b9, 0x5915, 0x5971, 0x59cc, 0x5a27,
	0x5a82, 0x5adc, 0x5b36, 0x5b90, 0x5be9, 0x5c42, 0x5c9b, 0x5cf3,
	0x5d4b, 0x5da3, 0x5dfa, 0x5e51, 0x5ea8, 0x5efe, 0x5f54, 0x5faa,
	0x6000, 0x6055, 0x60aa, 0x60fe, 0x6152, 0x61a7, 0x61fa, 0x624e,
	0x62a1, 0x62f4, 0x6347, 0x6399, 0x63eb, 0x643d, 0x648e, 0x64e0,
	0x6531, 0x6582, 0x65d2, 0x6623, 0x6673, 0x66c3, 0x6712, 0x6761,
	0x67b1, 0x6800, 0x684e, 0x689d, 0x68eb, 0x6939, 0x6986, 0x69d4,
	0x6a21, 0x6a6e, 0x6abb, 0x6b08, 0x6b54, 0x6ba1, 0x6bed, 0x6c38,
	0x6c84, 0x6ccf, 0x6d1a, 0x6d65, 0x6db0, 0x6dfb, 0x6e45, 0x6e8f,
	0x6ed9, 0x6f23, 0x6f6d, 0x6fb6, 0x7000, 0x7049, 0x7091, 0x70da,
	0x7123, 0x716b, 0x71b3, 0x71fb, 0x7243, 0x728a, 0x72d2, 0x7319,
	0x7360, 0x73a7, 0x73ee, 0x7434, 0x747b, 0x74c1, 0x7507, 0x754d,
	0x7593, 0x75d8, 0x761e, 0x7663, 0x76a8, 0x76ed, 0x7732, 0x7777,
	0x77bb, 0x7800, 0x7844, 0x7888, 0x78cc, 0x790f, 0x7953, 0x7996,
	0x79da, 0x7a1d, 0x7a60, 0x7aa3, 0x7ae5, 0x7b28, 0x7b6b, 0x7bad,
	0x7bef, 0x7c31, 0x7c73, 0x7cb5, 0x7cf6, 0x7d38, 0x7d79, 0x7dba,
	0x7dfb, 0x7e3c, 0x7e7d, 0x7ebe, 0x7efe, 0x7f3f, 0x7f7f, 0x7fbf
};

static const unsigned short v8_open_cj_rx_template[] = {
	0x0155U, 0x01c1U, 0x03ffU, 0x0155U, 0x01c1U, 0x03f0U
};

enum v8_open_phase {
	V8_OPEN_PHASE_BOOT = 0,
	V8_OPEN_PHASE_ANS_WAIT_FOR_CI,
	V8_OPEN_PHASE_ANS_SEND_ANSAM,
	V8_OPEN_PHASE_ANS_WAIT_FOR_CM,
	V8_OPEN_PHASE_ANS_SEND_JM,
	V8_OPEN_PHASE_ANS_WAIT_FOR_CJ,
	V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM,
	V8_OPEN_PHASE_ORG_SEND_CM,
	V8_OPEN_PHASE_ORG_WAIT_FOR_ANSAM,
	V8_OPEN_PHASE_ORG_WAIT_FOR_JM,
	V8_OPEN_PHASE_COMPLETE
};

enum v8_open_rx_collect_mode {
	V8_OPEN_RX_COLLECT_NONE = 0,
	V8_OPEN_RX_COLLECT_SEARCH,
	V8_OPEN_RX_COLLECT_CM,
	V8_OPEN_RX_COLLECT_CJ
};

struct v8_open_runtime_prefix {
	unsigned char flags0;
	unsigned char flags1;
	unsigned char flags2;
	unsigned char flags3;
	unsigned rate_a;
	unsigned rate_b;
	unsigned reserved_0c;
	unsigned qc_index;
};

struct v8_open_jm_shim {
	unsigned prepared;
	unsigned octet_count;
	unsigned word_count;
	unsigned data_supported;
	unsigned lapm_supported;
	unsigned quick_connect_supported;
	enum DP_ID preferred_dp;
	unsigned char modulation_mask;
	unsigned char modulation0_octet;
	unsigned char modulation1_octet;
	unsigned char modulation2_octet;
	unsigned char access_octet;
	unsigned char pcm_octet;
	unsigned short modulation0_word;
	unsigned short modulation1_word;
	unsigned short modulation2_word;
	unsigned short access_tag;
	unsigned short access_word;
	unsigned short call_function_code;
	unsigned short protocol_code;
	unsigned short pcm_word;
	unsigned has_modulation1;
	unsigned has_pcm;
	unsigned access_call_cellular;
	unsigned access_answer_cellular;
	unsigned access_digital;
	unsigned pcm_analog;
	unsigned pcm_digital;
	unsigned pcm_v91;
	unsigned short words[12];
	unsigned char octets[12];
	unsigned char decodable[12];
};

struct v8_open_tx_framer {
	unsigned enabled;
	unsigned short crc;
	unsigned short use_crc;
	unsigned short total_bits;
	unsigned short bit_cursor;
	unsigned short chunk_bits;
	unsigned short word_index;
	unsigned short repeat_enabled;
	unsigned short repeat_count;
	unsigned shift_reg;
	unsigned short bits_avail;
	unsigned restart_shift;
	unsigned short restart_bits;
};

struct v8_open_engine {
	struct v8_open_create_cfg cfg;
	enum v8_open_phase phase;
	unsigned samples_in_phase;
	unsigned total_samples;
	unsigned last_status;
	unsigned quick_connect_enabled;
	unsigned lapm_requested;
	unsigned initial_qc_index;
	unsigned char initial_flags0;
	unsigned char initial_flags1;
	unsigned char initial_flags2;
	unsigned short ans_det_04;
	unsigned short ans_det_06;
	short ans_det_08;
	unsigned short ans_det_0a;
	unsigned short ans_det_0c;
	unsigned short ans_det_0e;
	unsigned short ans_det_10;
	unsigned short ans_det_12;
	unsigned short ans_det_30;
	unsigned short ans_td_14;
	unsigned short ans_td_16;
	unsigned short ans_td_18;
	unsigned short ans_td_1a;
	unsigned short ans_td_1c;
	unsigned short ans_td_1e;
	unsigned short ans_td_20;
	unsigned short ans_td_22;
	unsigned short ans_td_24;
	unsigned short ans_td_26;
	unsigned short ans_td_28;
	unsigned short ans_td_2a;
	unsigned short ans_td_2c;
	unsigned short ans_td_2e;
	unsigned short ans_rx_0a;
	unsigned short ans_rx_14;
	unsigned short ans_rx_1a;
	unsigned short ans_rx_1c;
	unsigned short ans_rx_1e;
	unsigned short ans_rx_20;
	unsigned short ans_rx_82;
	unsigned short ans_rx_84;
	unsigned short ans_rx_86;
	unsigned short ans_rx_88;
	unsigned short ans_rx_8a;
	unsigned short ans_rx_ac;
	unsigned short ans_rx_c2;
	unsigned short ans_rx_c6;
	unsigned short ans_rx_c8;
	unsigned short ans_rx_d8;
	unsigned short ans_rx_da;
	unsigned ans_predetector_seeded;
	unsigned short rx_process_state;
	struct v8_open_jm_shim jm;
	enum DP_ID preferred_dp;
	unsigned tone_phase_q16;
	unsigned ansam_mod_phase_q16;
	unsigned ansam_phase_samples;
	unsigned ansam_phase_invert;
	unsigned tx_current_bit;
	unsigned tx_bit_pos;
	unsigned tx_bit_samples;
	unsigned tx_bit_len;
	unsigned tx_word_count;
	unsigned short tx_words[64];
	struct v8_open_tx_framer tx_framer;
	unsigned remote_call_data;
	unsigned remote_v34;
	unsigned remote_v32;
	unsigned remote_lapm;
	unsigned remote_access_present;
	unsigned remote_pcm_present;
	unsigned cm_seen_count;
	unsigned cm_signature;
	unsigned cm_detected;
	unsigned cm_guard_budget;
	unsigned cm_predetecting;
	unsigned det_e5c;
	unsigned det_e60;
	unsigned cm_predetect_deadline;
	unsigned cm_collecting;
	unsigned cm_collect_deadline;
	unsigned cm_collect_index;
	unsigned cm_collect_pass;
	unsigned cm_even_words;
	unsigned cm_force_suppress_count;
	unsigned cm_best_pass;
	unsigned cm_best_count;
	unsigned short cm_best_seq[V8OPEN_CM_WORDS];
	unsigned cm_confirm_valid_count;
	unsigned cm_confirm_word_count;
	unsigned short cm_confirm_seq[V8OPEN_CM_WORDS];
	unsigned have_call_match;
	unsigned have_proto_match;
	unsigned short matched_call_word;
	unsigned short matched_proto_word;
	unsigned rx_seq_a_count;
	unsigned short rx_seq_a[16];
	unsigned rx_seq_b_count;
	unsigned short rx_seq_b[16];
	unsigned rx_token_count;
	unsigned short rx_tokens[12];
	unsigned cj_seen_count;
	unsigned cj_signature;
	unsigned cj_detected;
	unsigned cj_guard_budget;
	unsigned cj_predetecting;
	unsigned cj_predetect_deadline;
	unsigned cj_collecting;
	unsigned cj_collect_deadline;
	unsigned cj_collect_index;
	unsigned cj_sequence_valid;
	unsigned cj_variant_bit;
	enum v8_open_rx_collect_mode rx_collect_mode;
	unsigned rx_align_locked;
	unsigned rx_skip_samples;
	unsigned rx_bit_window_len;
	unsigned short rx_shift_reg;
	unsigned short rx_preamble_expected;
	unsigned short rx_c220;
	unsigned short rx_c222;
	unsigned short rx_c224;
	unsigned short rx_c226;
	unsigned short rx_c228;
	unsigned short rx_c22a;
	unsigned short rx_c22c;
	unsigned short rx_c22e;
	unsigned short rx_sequence_len;
	unsigned rx_probe_bits;
	unsigned rx_probe_words_logged;
	unsigned rx_invert_bits;
	unsigned rx_reverse_word_bits;
	unsigned rx_word_sync;
	unsigned rx_bits_to_word;
	unsigned rx_phase_scan_index;
	unsigned rx_lock_skip_bits;
	unsigned rx_orient_flip;
	unsigned rx_demod_hist_fill;
	unsigned rx_phase_offset;
	unsigned short rx_c230;
	unsigned short rx_c232;
	unsigned short rx_c234;
	unsigned short rx_c236;
	unsigned short rx_c238;
	unsigned short rx_c23a;
	unsigned short rx_c23e;
	unsigned short rx_c240;
	unsigned short rx_c242;
	unsigned short rx_c244;
	unsigned short rx_c246;
	unsigned rx_mark_ticks;
	unsigned rx_space_ticks;
	unsigned rx_emit_total;
	unsigned rx_agc_gain_q15;
	unsigned rx_agc_env;
	unsigned rx_agc_metric;
	unsigned rx_agc_level;
	int rx_agc_integrator;
	unsigned rx_agc_rate_q16;
	unsigned rx_agc_ring_pos;
	short rx_agc_ring[V8OPEN_AGC_POWER_RING];
	unsigned rx_agc_block_fill;
	short rx_agc_block[V8OPEN_AGC_BLOCK_SAMPLES];
	unsigned rx_dbg_low_energy;
	unsigned rx_dbg_bit0;
	unsigned rx_dbg_bit1;
	unsigned rx_dbg_energy_log_counter;
	int rx_dbg_last_mark_e;
	int rx_dbg_last_space_e;
	unsigned rx_demod_profile;
	short rx_input_dc_state;
	unsigned ans_cm_timeout_fallback;
	unsigned ans_cj_timeout_fallback;
	unsigned cm_framing_stalls;
	unsigned ci_detected;
	unsigned ci_energy_counter;
	int tx_filt_state;
	short rx_agc_fir_hist[V8OPEN_AGC_FIR_SAMPLES];
	short rx_demod_history[V8OPEN_DEMOD_HISTORY_SAMPLES];
	short rx_bit_window[V8OPEN_MAX_SAMPLES_PER_BIT];
	unsigned char tx_bits[256];
};

static unsigned v8_open_rx_samples_per_bit(const struct v8_open_engine *engine);

static const char *v8_open_phase_name(enum v8_open_phase phase)
{
	switch (phase) {
	case V8_OPEN_PHASE_BOOT:
		return "BOOT";
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CI:
		return "ANS_WAIT_FOR_CI";
	case V8_OPEN_PHASE_ANS_SEND_ANSAM:
		return "ANS_SEND_ANSAM";
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CM:
		return "ANS_WAIT_FOR_CM";
	case V8_OPEN_PHASE_ANS_SEND_JM:
		return "ANS_SEND_JM";
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CJ:
		return "ANS_WAIT_FOR_CJ";
	case V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM:
		return "ANS_POST_CJ_CONFIRM";
	case V8_OPEN_PHASE_ORG_SEND_CM:
		return "ORG_SEND_CM";
	case V8_OPEN_PHASE_ORG_WAIT_FOR_ANSAM:
		return "ORG_WAIT_FOR_ANSAM";
	case V8_OPEN_PHASE_ORG_WAIT_FOR_JM:
		return "ORG_WAIT_FOR_JM";
	case V8_OPEN_PHASE_COMPLETE:
		return "COMPLETE";
	default:
		return "UNKNOWN";
	}
}

static const char *v8_open_status_name(unsigned status)
{
	switch (status) {
	case V8_OPEN_STATUS_INIT:
		return "V8_INIT";
	case V8_OPEN_STATUS_ANS_SEND_ANSAM:
		return "V8_ANS_SEND_ANSAM";
	case V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CM:
		return "V8_ANS_TIME_OUT_WAITING_FOR_CM";
	case V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CJ:
		return "V8_ANS_TIME_OUT_WAITING_FOR_CJ";
	case V8_OPEN_STATUS_ORG_SEND_CM:
		return "V8_ORG_SEND_CM";
	case V8_OPEN_STATUS_ANS_SEND_JM:
		return "V8_ANS_SEND_JM";
	case V8_OPEN_STATUS_ORG_JM_DETECTED:
		return "V8_ORG_JM_DETECTED";
	case V8_OPEN_STATUS_ORG_WAITING_FOR_QCA1D:
		return "V8_ORG_WAITING_FOR_QCA1d";
	case V8_OPEN_STATUS_OK:
		return "V8_OK";
	default:
		return "V8_UNKNOWN";
	}
}

static const char *v8_open_dp_name(enum DP_ID dp_id)
{
	switch (dp_id) {
	case DP_V92:
		return "V92";
	case DP_V90:
		return "V90";
	case DP_V34:
		return "V34";
	case DP_V32:
		return "V32";
	case DP_V22:
		return "V22";
	default:
		return "UNKNOWN";
	}
}

static unsigned char v8_open_reverse_bits(unsigned char value)
{
	unsigned char out;
	unsigned i;

	out = 0U;
	for (i = 0; i < 8U; ++i) {
		out <<= 1;
		out |= (unsigned char)(value & 0x01U);
		value >>= 1;
	}
	return out;
}

static unsigned short v8_open_encode_octet(unsigned char octet)
{
	unsigned char flipped;

	flipped = v8_open_reverse_bits(octet);
	return (unsigned short)(((unsigned short)flipped << 1) | 0x0001U);
}

static unsigned char v8_open_decode_word_octet(unsigned short word)
{
	return v8_open_reverse_bits((unsigned char)(word >> 1));
}

static unsigned short v8_open_reverse_word10(unsigned short word)
{
	unsigned short out;
	unsigned i;

	out = 0U;
	for (i = 0U; i < 10U; ++i) {
		out <<= 1;
		out |= (unsigned short)(word & 0x01U);
		word >>= 1;
	}
	return out;
}

static void v8_open_jm_push(struct v8_open_jm_shim *jm,
			    unsigned short word,
			    int decodable)
{
	unsigned index;

	index = jm->word_count;
	if (index >= (sizeof(jm->words) / sizeof(jm->words[0])))
		return;

	jm->words[index] = word;
	jm->decodable[index] = decodable ? 1U : 0U;
	jm->octets[index] = decodable ? v8_open_decode_word_octet(word) : 0U;
	jm->word_count = index + 1U;
}

static void v8_open_log_jm_sequence(const struct v8_open_jm_shim *jm)
{
	char words[128];
	char octets[160];
	size_t words_len;
	size_t octets_len;
	unsigned i;

	words[0] = '\0';
	octets[0] = '\0';
	words_len = 0U;
	octets_len = 0U;

	for (i = 0; i < jm->word_count; ++i) {
		int words_written;
		int octets_written;

		words_written = snprintf(words + words_len,
					 sizeof(words) - words_len,
					 "%s%03x",
					 i ? " " : "",
					 jm->words[i]);
		if (words_written > 0 &&
		    (size_t)words_written < sizeof(words) - words_len)
			words_len += (size_t)words_written;

		octets_written = snprintf(octets + octets_len,
					  sizeof(octets) - octets_len,
					  jm->decodable[i] ? "%s%02x" : "%s--",
					  i ? " " : "",
					  jm->octets[i]);
		if (octets_written > 0 &&
		    (size_t)octets_written < sizeof(octets) - octets_len)
			octets_len += (size_t)octets_written;
	}

	V8OPEN_DBG("jm-seq: words=[%s] octets=[%s]\n", words, octets);
}

static unsigned v8_open_samples_from_ms(const struct v8_open_engine *engine,
					unsigned ms)
{
	unsigned rate;

	rate = engine->cfg.sample_rate ? engine->cfg.sample_rate : 9600U;
	return (rate * ms) / 1000U;
}

static void v8_open_reset_tx(struct v8_open_engine *engine)
{
	engine->tone_phase_q16 = 0U;
	engine->ansam_mod_phase_q16 = 0U;
	engine->ansam_phase_samples = 0U;
	engine->ansam_phase_invert = 0U;
	engine->tx_filt_state = 0;
	engine->tx_current_bit = 1U;
	engine->tx_bit_pos = 0U;
	engine->tx_bit_samples = 0U;
	engine->tx_word_count = 0U;
	memset(&engine->tx_framer, 0, sizeof(engine->tx_framer));
}

static void v8_open_tx_push_bit(struct v8_open_engine *engine, unsigned bit)
{
	if (engine->tx_bit_len >= (sizeof(engine->tx_bits) / sizeof(engine->tx_bits[0])))
		return;
	engine->tx_bits[engine->tx_bit_len++] = (unsigned char)(bit ? 1U : 0U);
}

static void v8_open_tx_push_word(struct v8_open_engine *engine,
				 unsigned short word)
{
	int bit;

	for (bit = 9; bit >= 0; --bit)
		v8_open_tx_push_bit(engine, (word >> bit) & 0x01U);
}

static void v8_open_tx_push_framer_word(struct v8_open_engine *engine,
					unsigned short word)
{
	if (engine->tx_word_count >=
	    (sizeof(engine->tx_words) / sizeof(engine->tx_words[0])))
		return;
	engine->tx_words[engine->tx_word_count++] = word;
}

static void v8_open_tx_framer_crc_update(struct v8_open_tx_framer *framer,
					 unsigned shift_reg,
					 unsigned bit_count)
{
	unsigned short crc;
	int bit;

	crc = framer->crc;
	for (bit = (int)bit_count - 1; bit >= 0; --bit) {
		unsigned in_bit;
		unsigned msb;

		in_bit = (shift_reg >> (unsigned)bit) & 0x01U;
		msb = ((unsigned)crc >> 15) & 0x01U;
		crc <<= 1;
		if (msb ^ in_bit)
			crc ^= 0x1021U;
	}
	framer->crc = crc;
}

static int v8_open_tx_framer_getbit(struct v8_open_tx_framer *framer,
				    const unsigned short *words,
				    unsigned word_count)
{
	unsigned short bits_avail;
	int remaining;

	bits_avail = framer->bits_avail;
	if (!bits_avail) {
		remaining = (int)framer->total_bits - (int)framer->bit_cursor;
		if (remaining > 0) {
			unsigned take;
			unsigned word;

			take = framer->chunk_bits;
			if (take > (unsigned)remaining)
				take = (unsigned)remaining;

			if (framer->word_index < word_count)
				word = words[framer->word_index];
			else
				word = 0U;

			if (take >= framer->chunk_bits && framer->word_index < word_count)
				framer->word_index++;

			framer->bits_avail = (unsigned short)take;
			framer->shift_reg = (framer->shift_reg << take) | word;
			framer->bit_cursor = (unsigned short)(framer->bit_cursor + take);

			if (framer->use_crc && take)
				v8_open_tx_framer_crc_update(framer, framer->shift_reg, take);

			bits_avail = framer->bits_avail;
		} else if (remaining == -16) {
			framer->shift_reg = 0x000fU;
			framer->bits_avail = 4U;
			framer->bit_cursor = (unsigned short)(framer->bit_cursor + 4U);
			bits_avail = framer->bits_avail;
		} else if (framer->use_crc) {
			framer->shift_reg = framer->crc;
			framer->bits_avail = 16U;
			framer->bit_cursor = (unsigned short)(framer->bit_cursor + 16U);
			bits_avail = framer->bits_avail;
		} else if (framer->repeat_enabled) {
			framer->crc = 0xffffU;
			framer->repeat_count = (unsigned short)(framer->repeat_count + 1U);
			framer->bit_cursor = 0U;
			framer->word_index = 0U;
			framer->shift_reg = framer->restart_shift;
			framer->bits_avail = framer->restart_bits;
			return v8_open_tx_framer_getbit(framer, words, word_count);
		} else {
			return -1;
		}
	}

	if (!bits_avail)
		return -1;

	bits_avail--;
	framer->bits_avail = bits_avail;
	return (int)((framer->shift_reg >> bits_avail) & 0x01U);
}

static void v8_open_tx_framer_init(struct v8_open_engine *engine,
				   unsigned repeat_enabled)
{
	struct v8_open_tx_framer *framer;

	framer = &engine->tx_framer;
	memset(framer, 0, sizeof(*framer));
	framer->enabled = engine->tx_word_count > 0U;
	framer->crc = 0xffffU;
	framer->total_bits = (unsigned short)(engine->tx_word_count * 10U);
	framer->chunk_bits = 10U;
	framer->repeat_enabled = repeat_enabled ? 1U : 0U;
}

static void v8_open_prepare_jm_bits(struct v8_open_engine *engine)
{
	unsigned i;

	engine->tx_bit_len = 0U;
	engine->tx_bit_pos = 0U;
	engine->tx_bit_samples = 0U;
	engine->tx_word_count = 0U;
	engine->tx_current_bit = 1U;

	/*
	 * Blob answer-side path can start V.21 transmission from a short
	 * constructor-seeded buffer at +0x0d14 before it switches to the
	 * main JM buffer at +0x0c54. Mirror that by prepending the same
	 * 6-word pattern (0x03ff, 0x0155, 0x0111 repeated).
	 */
	if (engine->cfg.answer_mode) {
		static const unsigned short answer_seed_words[] = {
			0x03ffU, 0x0155U, 0x0111U,
			0x03ffU, 0x0155U, 0x0111U
		};

		for (i = 0; i < (sizeof(answer_seed_words) / sizeof(answer_seed_words[0])); ++i) {
			v8_open_tx_push_framer_word(engine, answer_seed_words[i]);
			v8_open_tx_push_word(engine, answer_seed_words[i]);
		}
	}

	for (i = 0; i < engine->jm.word_count; ++i) {
		v8_open_tx_push_framer_word(engine, engine->jm.words[i]);
		v8_open_tx_push_word(engine, engine->jm.words[i]);
	}

	/* v8_getbit-backed framing repeats the JM sequence while waiting for CJ. */
	v8_open_tx_framer_init(engine, 1U);

	V8OPEN_DBG("jm-bits: bits=%u\n", engine->tx_bit_len);
}

static short v8_open_wave_sample_phase(const struct v8_open_engine *engine,
				       unsigned *phase_q16,
				       unsigned freq_hz)
{
	unsigned rate;
	unsigned step;
	unsigned index;

	rate = engine->cfg.sample_rate ? engine->cfg.sample_rate : 9600U;
	step = (unsigned)(((unsigned long long)freq_hz << 16) / rate);
	*phase_q16 += step;
	index = (*phase_q16 >> 8) & 0xffU;
	return v8_open_sine_256[index];
}

static short v8_open_wave_sample(struct v8_open_engine *engine,
				 unsigned freq_hz,
				 int invert)
{
	short sample;

	sample = v8_open_wave_sample_phase(engine, &engine->tone_phase_q16, freq_hz);
	if (invert)
		sample = (short)-sample;
	return sample;
}

/*
 * Simple single-pole IIR lowpass on TX ANSam path.
 * Cutoff ~3500 Hz at 9600 Hz sample rate.
 * alpha = 1 - exp(-2*pi*3500/9600) ≈ 0.899.
 * Attenuates 2100 Hz by only ~0.8 dB, suppresses aliased harmonics.
 * Uses Q14 fixed-point: alpha=14726 (0.899), (1-alpha)=1658 (0.101).
 */
static short v8_open_tx_filter(struct v8_open_engine *engine, short sample)
{
	int out;

	out = (14726 * (int)sample + 1658 * engine->tx_filt_state) >> 14;
	if (out > 32767) out = 32767;
	if (out < -32767) out = -32767;
	engine->tx_filt_state = out;
	return (short)out;
}

static void v8_open_emit_ansam(struct v8_open_engine *engine,
			       short *pcm,
			       int cnt)
{
	unsigned leadin_samples;
	unsigned reversal_samples;
	int i;

	leadin_samples = v8_open_samples_from_ms(engine, V8OPEN_ANSAM_LEADIN_MS);
	reversal_samples = v8_open_samples_from_ms(engine, V8OPEN_ANSAM_REVERSAL_MS);
	if (!reversal_samples)
		reversal_samples = 1U;

	for (i = 0; i < cnt; ++i) {
		unsigned elapsed;
		short carrier;
		short am;
		int envelope;
		int sample;

		elapsed = engine->samples_in_phase + (unsigned)i;
		if (elapsed < leadin_samples) {
			pcm[i] = 0;
			continue;
		}

		carrier = v8_open_wave_sample(engine,
					     V8OPEN_ANSAM_FREQ,
					     (int)engine->ansam_phase_invert);
		am = v8_open_wave_sample_phase(engine,
					      &engine->ansam_mod_phase_q16,
					      V8OPEN_ANSAM_AM_FREQ);
		envelope = V8OPEN_PCM_AMPLITUDE + (am / (int)V8OPEN_ANSAM_AM_DIVISOR);
		sample = ((int)carrier * envelope) / V8OPEN_PCM_AMPLITUDE;
		pcm[i] = v8_open_tx_filter(engine, (short)sample);
		engine->ansam_phase_samples++;
		if (engine->ansam_phase_samples >= reversal_samples) {
			engine->ansam_phase_samples = 0U;
			engine->ansam_phase_invert ^= 1U;
		}
	}
}

static void v8_open_emit_v21(struct v8_open_engine *engine,
			     short *pcm,
			     int cnt,
			     int answer_mode);

static void v8_open_emit_confirm_tone(struct v8_open_engine *engine,
				      short *pcm,
				      int cnt)
{
	(void)engine;
	memset(pcm, 0, (size_t)cnt * sizeof(*pcm));
}

static void v8_open_emit_v21(struct v8_open_engine *engine,
			     short *pcm,
			     int cnt,
			     int answer_mode)
{
	unsigned samples_per_bit;
	unsigned mark_hz;
	unsigned space_hz;
	int i;

	samples_per_bit = engine->cfg.sample_rate ?
		(engine->cfg.sample_rate / V8OPEN_V21_BITRATE) : 32U;
	if (!samples_per_bit)
		samples_per_bit = 32U;

	if (answer_mode) {
		mark_hz = V8OPEN_V21_ANS_MARK;
		space_hz = V8OPEN_V21_ANS_SPACE;
	} else {
		mark_hz = V8OPEN_V21_ORG_MARK;
		space_hz = V8OPEN_V21_ORG_SPACE;
	}

	for (i = 0; i < cnt; ++i) {
		unsigned bit;
		unsigned freq_hz;
		unsigned loop_stream;

		loop_stream = answer_mode &&
			(engine->phase == V8_OPEN_PHASE_ANS_SEND_JM ||
			 engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CJ) &&
			engine->tx_bit_len > 0U;

		if (engine->tx_bit_samples == 0U) {
			if (loop_stream && engine->tx_framer.enabled) {
				int framed_bit;

				framed_bit = v8_open_tx_framer_getbit(&engine->tx_framer,
							      engine->tx_words,
							      engine->tx_word_count);
				engine->tx_current_bit = framed_bit >= 0 ? (unsigned)framed_bit : 1U;
				if (engine->tx_bit_pos < engine->tx_bit_len)
					engine->tx_bit_pos++;
			} else {
				if (loop_stream && engine->tx_bit_pos >= engine->tx_bit_len)
					engine->tx_bit_pos = 0U;
				engine->tx_current_bit = 1U;
				if (engine->tx_bit_pos < engine->tx_bit_len)
					engine->tx_current_bit = engine->tx_bits[engine->tx_bit_pos];
			}
		}
		bit = engine->tx_current_bit;

		freq_hz = bit ? mark_hz : space_hz;
		pcm[i] = v8_open_wave_sample(engine, freq_hz, 0);

		engine->tx_bit_samples++;
		if (engine->tx_bit_samples >= samples_per_bit) {
			engine->tx_bit_samples = 0U;
			if (!engine->tx_framer.enabled && engine->tx_bit_pos < engine->tx_bit_len)
				engine->tx_bit_pos++;
			if (!engine->tx_framer.enabled &&
			    loop_stream && engine->tx_bit_pos >= engine->tx_bit_len)
				engine->tx_bit_pos = 0U;
		}
	}
}

static void v8_open_emit_phase(struct v8_open_engine *engine, void *out, int cnt)
{
	short *pcm = out;

	if (!out || cnt <= 0)
		return;

	switch (engine->phase) {
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CI:
		/* Silence while listening for calling modem's CI/CNG tone. */
		memset(out, 0, (size_t)cnt * 2U);
		break;
	case V8_OPEN_PHASE_ANS_SEND_ANSAM:
		v8_open_emit_ansam(engine, pcm, cnt);
		break;
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CM:
		/* Quiet tail to improve CM receive SNR after long ANSam burst. */
		memset(out, 0, (size_t)cnt * 2U);
		break;
	case V8_OPEN_PHASE_ANS_SEND_JM:
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CJ:
		v8_open_emit_v21(engine, pcm, cnt, 1);
		break;
	case V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM:
		if (engine->ans_cm_timeout_fallback)
			memset(out, 0, (size_t)cnt * 2U);
		else
			v8_open_emit_confirm_tone(engine, pcm, cnt);
		break;
	case V8_OPEN_PHASE_ORG_SEND_CM:
		v8_open_emit_v21(engine, pcm, cnt, 0);
		break;
	default:
		memset(out, 0, (size_t)cnt * 2U);
		break;
	}
}

static unsigned v8_open_phase_budget(const struct v8_open_engine *engine,
				     enum v8_open_phase phase)
{
	unsigned samples_per_bit;

	samples_per_bit = engine->cfg.sample_rate ?
		(engine->cfg.sample_rate / V8OPEN_V21_BITRATE) : 32U;
	if (!samples_per_bit)
		samples_per_bit = 32U;
	if (samples_per_bit > V8OPEN_MAX_SAMPLES_PER_BIT)
		samples_per_bit = V8OPEN_MAX_SAMPLES_PER_BIT;

	switch (phase) {
	case V8_OPEN_PHASE_BOOT:
		/* V.8 8.2: at least 0.2 s no-signal after line connection. */
		return v8_open_samples_from_ms(engine, 200U);
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CI:
		/*
		 * Wait for calling modem's CI/CNG tone before starting ANSam.
		 * Blob v8handshak starts in silence (TX=0x05, RX=0x19) and
		 * calls v8_tone_detect() each tick; ANSam only begins after
		 * detection succeeds.  Budget is the sig_timeout fallback.
		 */
		return v8_open_samples_from_ms(engine, V8OPEN_CI_WAIT_TIMEOUT_MS);
	case V8_OPEN_PHASE_ANS_SEND_ANSAM:
		/*
		 * V.8 8.2.2: if not terminated by CM/sigC, ANSam is 5 +- 1 s.
		 * Keep total ANSam + CM wait near 5 s, with a receive-focused tail.
		 */
		if (engine->cm_detected && engine->cm_guard_budget)
			return engine->cm_guard_budget;
		return v8_open_samples_from_ms(engine, V8OPEN_ANSAM_SEND_MS);
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CM:
	{
		unsigned wait_tail;

		wait_tail = v8_open_samples_from_ms(engine, V8OPEN_CM_WAIT_TAIL_MS);
		if (!engine->cm_detected && engine->cm_confirm_valid_count > 0U) {
			unsigned confirm_tail;

			confirm_tail = v8_open_samples_from_ms(
				engine,
				V8OPEN_CM_WAIT_TAIL_AFTER_FIRST_VALID_MS);
			if (confirm_tail > wait_tail)
				wait_tail = confirm_tail;
		}
		/*
		 * If CM search is active when we enter/are in WAIT_FOR_CM, keep the
		 * phase alive through the active detector/collector deadline so we
		 * do not force fallback mid-attempt.
		 */
		if (engine->cm_collecting && engine->cm_collect_deadline)
			return engine->cm_collect_deadline > wait_tail ?
				engine->cm_collect_deadline : wait_tail;
		if (engine->cm_predetecting && engine->cm_predetect_deadline)
			return engine->cm_predetect_deadline > wait_tail ?
				engine->cm_predetect_deadline : wait_tail;
		if (engine->cm_detected && engine->cm_guard_budget)
			return engine->cm_guard_budget < wait_tail ?
				engine->cm_guard_budget : wait_tail;
		return wait_tail;
	}
	case V8_OPEN_PHASE_ANS_SEND_JM:
		/* Real JM dwell is about 0.82 s before V8_OK. */
		return v8_open_samples_from_ms(engine, 820U);
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CJ:
	{
		unsigned wait_tail;
		unsigned detector_deadline;

		wait_tail = v8_open_samples_from_ms(engine, V8OPEN_CJ_WAIT_MS);
		if (engine->cj_detected && engine->cj_guard_budget)
			return engine->cj_guard_budget < wait_tail ?
				engine->cj_guard_budget : wait_tail;

		detector_deadline = 0U;
		if (engine->cj_predetecting) {
			if (engine->ans_det_06 && engine->cj_predetect_deadline)
				detector_deadline = engine->cj_predetect_deadline;
			else if (engine->det_e60)
				detector_deadline = engine->det_e60;
			else if (engine->cj_predetect_deadline)
				detector_deadline = engine->cj_predetect_deadline;
		}
		if (engine->cj_collecting && engine->cj_collect_deadline &&
		    engine->cj_collect_deadline > detector_deadline)
			detector_deadline = engine->cj_collect_deadline;

		if (detector_deadline > wait_tail)
			return detector_deadline;
		return wait_tail;
	}
	case V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM:
		/*
		 * V.8 8.2.2 timeout fallback inserts a 75 ± 5 ms no-signal gap.
		 * Keep the short post-CJ settle in the normal JM/CJ success path.
		 */
		if (engine->ans_cm_timeout_fallback)
			return v8_open_samples_from_ms(engine, 75U);
		return v8_open_samples_from_ms(engine, 5U);
	case V8_OPEN_PHASE_ORG_SEND_CM:
		return v8_open_samples_from_ms(engine, 160U);
	case V8_OPEN_PHASE_ORG_WAIT_FOR_ANSAM:
		return v8_open_samples_from_ms(engine, 420U);
	case V8_OPEN_PHASE_ORG_WAIT_FOR_JM:
		return v8_open_samples_from_ms(engine, 180U);
	case V8_OPEN_PHASE_COMPLETE:
	default:
		return 0U;
	}
}

static unsigned v8_open_capture_signature(const short *samples,
					  int cnt,
					  unsigned *avg_abs_out,
					  unsigned *peak_abs_out)
{
	unsigned sum_abs;
	unsigned peak_abs;
	unsigned zero_crossings;
	unsigned last_sign;
	int i;

	sum_abs = 0U;
	peak_abs = 0U;
	zero_crossings = 0U;
	last_sign = 0U;

	for (i = 0; i < cnt; ++i) {
		short sample;
		unsigned mag;
		unsigned sign;

		sample = samples[i];
		mag = (unsigned)(sample < 0 ? -sample : sample);
		sum_abs += mag;
		if (mag > peak_abs)
			peak_abs = mag;
		if (!sample)
			continue;
		sign = sample < 0 ? 2U : 1U;
		if (last_sign && sign != last_sign)
			zero_crossings++;
		last_sign = sign;
	}

	if (avg_abs_out)
		*avg_abs_out = cnt > 0 ? (sum_abs / (unsigned)cnt) : 0U;
	if (peak_abs_out)
		*peak_abs_out = peak_abs;

	return (((sum_abs / (unsigned)(cnt > 0 ? cnt : 1)) >> 6) & 0xffU) |
	       ((zero_crossings & 0xffU) << 8);
}

static void v8_open_rx_start_search(struct v8_open_engine *engine);

static int v8_open_mpyint(short sample, short coeff)
{
	int prod;

	prod = (int)sample * (int)coeff;
	return prod >> 14;
}

static unsigned short v8_open_answer_detector_metric(struct v8_open_engine *engine,
						     short sample)
{
	static const short fir_ff[3] = {
		(short)0x3ccdU, (short)0xe087U, (short)0x3ccdU
	};
	static const short fir_fb[2] = {
		(short)0xe087U, (short)0x39c3U
	};
	static const short sec0_ff[2] = {
		0, 0
	};
	static const short sec0_fb[2] = {
		(short)0xe630U, (short)0x3c38U
	};
	static const short sec1_ff[2] = {
		0, 0
	};
	static const short sec1_fb[2] = {
		(short)0xe960U, (short)0x3c38U
	};
	unsigned short old14;
	unsigned short old18;
	unsigned short old1c;
	unsigned short old20;
	int stage0;
	int stage1;
	int stage2;
	int stage0_q;
	int stage1_q;
	int metric;
	unsigned i;

	engine->ans_td_24 = (unsigned short)sample;

	stage0 = 0;
	for (i = 0U; i < 3U; ++i) {
		unsigned short hist;

		hist = i == 0U ? engine->ans_td_24 :
			(i == 1U ? engine->ans_td_26 : engine->ans_td_28);
		stage0 += (int)v8_open_mpyint((short)hist, fir_ff[i]);
	}
	for (i = 0U; i < 2U; ++i) {
		unsigned short hist;

		hist = i == 0U ? engine->ans_td_2a : engine->ans_td_2c;
		stage0 -= (int)v8_open_mpyint((short)hist, fir_fb[i]);
	}

	engine->ans_td_28 = engine->ans_td_26;
	engine->ans_td_26 = engine->ans_td_24;
	engine->ans_td_2e = engine->ans_td_2c;
	engine->ans_td_2c = engine->ans_td_2a;
	engine->ans_td_2a = (unsigned short)stage0;

	stage0_q = (short)stage0;
	stage0_q >>= 4;
	stage1 = stage0_q;
	for (i = 0U; i < 2U; ++i) {
		unsigned short ff_state;
		unsigned short fb_state;

		ff_state = i == 0U ? engine->ans_td_14 : engine->ans_td_16;
		fb_state = i == 0U ? engine->ans_td_1c : engine->ans_td_1e;
		stage1 += (int)v8_open_mpyint((short)ff_state, sec0_ff[i]);
		stage1 -= (int)v8_open_mpyint((short)fb_state, sec0_fb[i]);
	}

	old14 = engine->ans_td_14;
	old1c = engine->ans_td_1c;
	engine->ans_td_1c = (unsigned short)stage1;
	engine->ans_td_14 = (unsigned short)stage0_q;
	engine->ans_td_16 = old14;
	engine->ans_td_1e = old1c;

	stage1_q = (short)stage1;
	stage1_q >>= 4;
	stage2 = stage1_q;
	for (i = 0U; i < 2U; ++i) {
		unsigned short ff_state;
		unsigned short fb_state;

		ff_state = i == 0U ? engine->ans_td_18 : engine->ans_td_1a;
		fb_state = i == 0U ? engine->ans_td_20 : engine->ans_td_22;
		stage2 += (int)v8_open_mpyint((short)ff_state, sec1_ff[i]);
		stage2 -= (int)v8_open_mpyint((short)fb_state, sec1_fb[i]);
	}

	old18 = engine->ans_td_18;
	old20 = engine->ans_td_20;
	engine->ans_td_20 = (unsigned short)stage2;
	engine->ans_td_1a = old18;
	engine->ans_td_18 = (unsigned short)stage1_q;
	engine->ans_td_22 = old20;

	metric = stage2;
	metric >>= 4;
	if (metric < 0)
		metric = -metric;
	metric += (int)v8_open_mpyint((short)engine->ans_det_12, (short)0x3ccdU);
	if (metric < 0)
		metric = 0;
	if (metric > 0x7fff)
		metric = 0x7fff;
	return (unsigned short)metric;
}

static unsigned v8_open_answer_detector_step(struct v8_open_engine *engine,
					     const short *samples,
					     int cnt,
					     unsigned *hit_count_out,
					     unsigned *peak_abs_out)
{
	unsigned hit_count;
	unsigned peak_abs;
	unsigned stage1_metric_min;
	unsigned stage1_run_min;
	int i;

	if (!engine || !samples || cnt <= 0) {
		if (hit_count_out)
			*hit_count_out = 0U;
		if (peak_abs_out)
			*peak_abs_out = 0U;
		return 0U;
	}

	hit_count = 0U;
	peak_abs = 0U;
	stage1_metric_min = (engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CM) ?
		V8OPEN_CM_STAGE1_METRIC_MIN_WAIT :
		V8OPEN_CM_STAGE1_METRIC_MIN_SEND;
	stage1_run_min = (engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CM) ?
		V8OPEN_CM_STAGE1_RUN_MIN_WAIT :
		V8OPEN_CM_STAGE1_RUN_MIN_SEND;

	for (i = 0; i < cnt; ++i) {
		engine->ans_det_12 = v8_open_answer_detector_metric(engine, samples[i]);
		if (engine->ans_det_12 > peak_abs)
			peak_abs = engine->ans_det_12;

		if (engine->ans_det_04 != 0U) {
			if (engine->ans_det_12 < engine->ans_det_0e)
				engine->ans_det_08++;
			if (engine->ans_det_12 > engine->ans_det_10)
				engine->ans_det_08 = 0;
			if ((unsigned short)engine->ans_det_08 > engine->ans_det_0a) {
				hit_count++;
				if (hit_count_out)
					*hit_count_out = hit_count;
				if (peak_abs_out)
					*peak_abs_out = peak_abs;
				return 1U;
			}
			continue;
		}

		if (engine->ans_det_06 != 0U) {
			if (engine->ans_det_12 > engine->ans_det_10)
				engine->ans_det_08++;
			if ((unsigned short)engine->ans_det_08 > engine->ans_det_0a) {
				hit_count++;
				if (hit_count_out)
					*hit_count_out = hit_count;
				if (peak_abs_out)
					*peak_abs_out = peak_abs;
				return 1U;
			}
			if (engine->ans_det_12 > engine->ans_det_10)
				hit_count++;
			continue;
		}

		if (engine->ans_det_12 > stage1_metric_min) {
			hit_count++;
			engine->ans_det_30 = (unsigned short)(engine->ans_det_30 + 1U);
			if (engine->ans_det_30 >= stage1_run_min) {
				engine->ans_det_06 = 1U;
				engine->ans_rx_0a =
					(unsigned short)(engine->ans_rx_0a & ~0x0200U);
				engine->ans_det_08 = 0;
				engine->ans_det_30 = (unsigned short)stage1_run_min;
			}
		} else {
			engine->ans_det_30 = 0U;
		}
	}

	if (hit_count_out)
		*hit_count_out = hit_count;
	if (peak_abs_out)
		*peak_abs_out = peak_abs;
	return 0U;
}

static void v8_open_answer_rx_init(struct v8_open_engine *engine)
{
	engine->ans_rx_0a = 0x8000U;
	engine->ans_rx_14 = 0U;
	engine->ans_rx_1a = 0U;
	engine->ans_rx_1c = 0x0200U;
	engine->ans_rx_1e = 0U;
	engine->ans_rx_20 = 0x3333U;
	engine->ans_rx_82 = 0U;
	engine->ans_rx_84 = 0U;
	engine->ans_rx_86 = 0x0200U;
	engine->ans_rx_88 = 0U;
	engine->ans_rx_8a = 0U;
	engine->ans_rx_ac = 0U;
	engine->ans_rx_c2 = 0x0050U;
	engine->ans_rx_c6 = 0U;
	engine->ans_rx_c8 = 0U;
	engine->ans_rx_d8 = 0U;
	engine->ans_rx_da = 0U;
}

static void v8_open_answer_detector_init(struct v8_open_engine *engine)
{
	/*
	 * Mirror the answer-side v8_detectorinit call site from v8handshakinit:
	 * v8_detectorinit(engine, &engine->det, 0x5670, 0, 0x64, 0x32, 0x5dc, 0)
	 *
	 * The detector fields land as:
	 * +0x04 = 0
	 * +0x06 = 0
	 * +0x08 = -(0x32)
	 * +0x0a = 0x64
	 * +0x0c = 1
	 * +0x0e = 0
	 * +0x10 = 0x5dc
	 * +0x12 = 0
	 * +0x30 = 0
	 */
	engine->ans_det_04 = 0U;
	engine->ans_det_06 = 0U;
	engine->ans_det_08 = (short)-0x32;
	engine->ans_det_0a = 0x0064U;
	engine->ans_det_0c = 1U;
	engine->ans_det_0e = 0U;
	engine->ans_det_10 = 0x05dcU;
	engine->ans_det_12 = 0U;
	engine->ans_det_30 = 0U;
	engine->ans_rx_0a = (unsigned short)(engine->ans_rx_0a | 0x0200U);
	engine->ans_td_14 = 0U;
	engine->ans_td_16 = 0U;
	engine->ans_td_18 = 0U;
	engine->ans_td_1a = 0U;
	engine->ans_td_1c = 0U;
	engine->ans_td_1e = 0U;
	engine->ans_td_20 = 0U;
	engine->ans_td_22 = 0U;
	engine->ans_td_24 = 0U;
	engine->ans_td_26 = 0U;
	engine->ans_td_28 = 0U;
	engine->ans_td_2a = 0U;
	engine->ans_td_2c = 0U;
	engine->ans_td_2e = 0U;
}

static void v8_open_answer_predetector_seed(struct v8_open_engine *engine)
{
	if (!engine || !engine->cfg.answer_mode)
		return;

	v8_open_answer_rx_init(engine);
	v8_open_answer_detector_init(engine);
	engine->ans_predetector_seeded = 1U;
}

static void v8_open_answer_predetector_arm(struct v8_open_engine *engine)
{
	if (!engine || !engine->cfg.answer_mode)
		return;

	if (!engine->ans_predetector_seeded)
		v8_open_answer_predetector_seed(engine);
	else {
		v8_open_answer_rx_init(engine);
		v8_open_answer_detector_init(engine);
	}

	engine->ans_rx_1a = 0U;
	engine->ans_rx_14 = 0U;
	engine->ans_rx_c8 = 0U;
	engine->ans_rx_c6 = 0U;
	v8_open_rx_start_search(engine);
}

static unsigned v8_open_answer_detector_window(const struct v8_open_engine *engine)
{
	int window;

	if (!engine)
		return 0U;
	window = -(int)engine->ans_det_08;
	if (window < 0)
		window = -window;
	return (unsigned)window;
}

static void v8_open_rx_push_token(struct v8_open_engine *engine,
				  unsigned short token)
{
	if (engine->rx_token_count >=
	    (sizeof(engine->rx_tokens) / sizeof(engine->rx_tokens[0])))
		return;
	engine->rx_tokens[engine->rx_token_count++] = token;
}

static void v8_open_rx_seq_a_push(struct v8_open_engine *engine,
				  unsigned short word)
{
	if (engine->rx_seq_a_count >=
	    (sizeof(engine->rx_seq_a) / sizeof(engine->rx_seq_a[0])))
		return;
	engine->rx_seq_a[engine->rx_seq_a_count++] = word;
}

static unsigned v8_open_word_hamming_masked10(unsigned short a,
					      unsigned short b,
					      unsigned short mask)
{
	unsigned x;
	unsigned d;

	x = (unsigned)((a ^ b) & mask & 0x03ffU);
	d = 0U;
	while (x) {
		d += (x & 0x01U);
		x >>= 1;
	}
	return d;
}

static int v8_open_word_match_category(unsigned short word,
				       unsigned short category_masked)
{
	unsigned short w;
	unsigned short c;

	w = (unsigned short)(word & 0x03ffU);
	c = (unsigned short)(category_masked & 0x03ffU);
	if ((w & 0x03f1U) == (c & 0x03f1U))
		return 1;
	if (v8_open_word_hamming_masked10(w, c, 0x03f1U) <= 1U)
		return 1;

	/* Tolerate occasional bit9 contamination from framing slips. */
	w = (unsigned short)(w & 0x01ffU);
	if ((w & 0x03f1U) == (c & 0x03f1U))
		return 1;
	if (v8_open_word_hamming_masked10(w, c, 0x01f1U) <= 1U)
		return 1;

	/* Tolerate missing bit8 in weak-lock windows. */
	if ((w & 0x01f1U) == (c & 0x01f1U))
		return 1;
	if (v8_open_word_hamming_masked10(w, c, 0x01f1U) <= 1U)
		return 1;

	return 0;
}

static int v8_open_word_match_mod_ext(unsigned short word)
{
	unsigned short w;

	w = (unsigned short)(word & 0x03ffU);
	if ((w & 0x0039U) == 0x0011U)
		return 1;

	w = (unsigned short)(w & 0x01ffU);
	return ((w & 0x0039U) == 0x0011U) ? 1 : 0;
}

static unsigned v8_open_word_hamming10(unsigned short a, unsigned short b)
{
	unsigned x;
	unsigned d;

	x = (unsigned)((a ^ b) & 0x03ffU);
	d = 0U;
	while (x) {
		d += (x & 0x01U);
		x >>= 1;
	}
	return d;
}

static unsigned short v8_open_find_rx_token(const struct v8_open_engine *engine,
					    unsigned short category_masked,
					    unsigned nth)
{
	unsigned i;
	unsigned seen;

	if ((category_masked == 0x0141U || category_masked == 0x01c1U) &&
	    nth > 0U) {
		for (i = 0; i < engine->rx_token_count; ++i) {
			unsigned short token;
			unsigned ext_seen;
			unsigned j;

			token = engine->rx_tokens[i];
			if (!v8_open_word_match_category(token, 0x0141U))
				continue;

			ext_seen = 0U;
			for (j = i + 1U; j < engine->rx_token_count; ++j) {
				unsigned short ext;

				ext = engine->rx_tokens[j];
				if (!v8_open_word_match_mod_ext(ext))
					break;
				ext_seen++;
				if (ext_seen == nth)
					return ext;
			}
			return 0U;
		}
		return 0U;
	}

	seen = 0U;
	for (i = 0; i < engine->rx_token_count; ++i) {
		unsigned short token;

		token = engine->rx_tokens[i];
		if (!v8_open_word_match_category(token, category_masked))
			continue;
		if (seen == nth)
			return token;
		seen++;
	}
	return 0U;
}

static void v8_open_collect_remote_cj_defaults(struct v8_open_engine *engine)
{
	unsigned i;

	engine->rx_seq_a_count = 0U;
	for (i = 0U; i < (sizeof(v8_open_cj_rx_template) / sizeof(v8_open_cj_rx_template[0])); ++i)
		v8_open_rx_seq_a_push(engine, v8_open_cj_rx_template[i]);
}

static unsigned v8_open_rx_samples_per_bit(const struct v8_open_engine *engine)
{
	unsigned samples_per_bit;

	samples_per_bit = engine->cfg.sample_rate ?
		(engine->cfg.sample_rate / V8OPEN_V21_BITRATE) : 32U;
	if (!samples_per_bit)
		samples_per_bit = 32U;
	if (samples_per_bit > V8OPEN_MAX_SAMPLES_PER_BIT)
		samples_per_bit = V8OPEN_MAX_SAMPLES_PER_BIT;
	return samples_per_bit;
}

static unsigned v8_open_rx_quantize_transition_clear(unsigned *counter)
{
	unsigned phase_count;
	unsigned whole_bits;
	unsigned remainder;
	unsigned stride;
	unsigned threshold;
	unsigned emit_count;

	phase_count = *counter;
	if (!phase_count)
		return 0U;

	remainder = phase_count & 0x03U;
	whole_bits = phase_count >> 2;
	/*
	 * Blob v8_fskdemodulate temporarily stores the modulo-4 remainder for
	 * the threshold calculation, then clears the counter to zero after the
	 * transition.  The remainder influences the rounding decision but does
	 * NOT carry forward into the next accumulation cycle.
	 */
	/* remainder is used only for threshold check below, then counter is cleared */
	*counter = 0U;
	stride = whole_bits > 2U ? 3U : (whole_bits + 1U);
	threshold = 4U - stride;
	emit_count = whole_bits;
	if (remainder >= threshold)
		emit_count++;
	return emit_count;
}

static unsigned v8_open_rx_quantize_block_flush(unsigned *counter)
{
	unsigned phase_count;
	unsigned whole_bits;

	phase_count = *counter;
	if (phase_count <= 4U)
		return 0U;

	whole_bits = phase_count >> 2;
	*counter = phase_count & 0x03U;
	return whole_bits;
}

static int v8_open_rx_push_bit(struct v8_open_engine *engine, unsigned bit);
static int v8_open_rx_consume_samples(struct v8_open_engine *engine,
				      const short *samples,
				      int cnt);
static void v8_open_parse_rx_sequence(struct v8_open_engine *engine);
static int v8_open_cm_sequence_valid(struct v8_open_engine *engine);
static int v8_open_try_salvage_best_cm(struct v8_open_engine *engine);

static unsigned v8_open_abs_u32_from_i32(int v)
{
	return (unsigned)(v < 0 ? -v : v);
}

static int v8_open_handoff_ready(const struct v8_open_engine *engine,
				 unsigned avg_abs,
				 unsigned peak_abs)
{
	unsigned bit0;
	unsigned bit1;
	unsigned total;

	/*
	 * Avoid kicking CM/CJ collector on near-silence or one-sided demod
	 * streams (typically local ANSam leakage). Require some symbol
	 * diversity before committing to framing collection.
	 */
	if (avg_abs < 64U && peak_abs < 128U)
		return 0;
	if (!engine)
		return 0;

	bit0 = engine->rx_dbg_bit0;
	bit1 = engine->rx_dbg_bit1;
	total = bit0 + bit1;
	if (total < 64U)
		return 0;
	if (bit0 > (bit1 * 16U) || bit1 > (bit0 * 16U))
		return 0;

	return 1;
}

static int v8_open_stage2_monobit(const struct v8_open_engine *engine,
				  unsigned min_total_bits)
{
	unsigned bit0;
	unsigned bit1;
	unsigned total;

	if (!engine)
		return 0;

	bit0 = engine->rx_dbg_bit0;
	bit1 = engine->rx_dbg_bit1;
	total = bit0 + bit1;
	if (total < min_total_bits)
		return 0;

	if (bit0 == 0U || bit1 == 0U)
		return 1;
	if (bit0 > (bit1 * 32U) || bit1 > (bit0 * 32U))
		return 1;
	return 0;
}

static short v8_open_rx_agc_prefilter_sample(struct v8_open_engine *engine, short sample)
{
	const short *coeffs;
	long long acc;
	unsigned i;

	/*
	 * Blob V8agc: +a44==0 selects 0x5480, non-zero selects 0x5420.
	 * Blob convention: answer_mode=0 is answer, =1 is originate.
	 * Stub convention: answer_mode=1 is answer, =0 is originate.
	 * Flip the ternary so the answer side gets filt_5480 (passes the
	 * originate V.21 band we need to receive) and vice versa.
	 */
	coeffs = engine->cfg.answer_mode ?
		v8_open_agc_filt_5480 : v8_open_agc_filt_5420;

	engine->rx_agc_fir_hist[0] = sample;
	/*
	 * Blob V8agc accumulates the FIR sum directly and then arithmetic-shifts
	 * by 14 (no +0x2000 rounding bias in this stage).
	 */
	acc = 0;
	for (i = 0U; i < V8OPEN_AGC_FIR_SAMPLES; ++i) {
		acc += (long long)engine->rx_agc_fir_hist[i] *
			(long long)coeffs[i];
	}
	acc >>= 14;
	if (acc > 32767LL)
		acc = 32767LL;
	else if (acc < -32768LL)
		acc = -32768LL;
	memmove(engine->rx_agc_fir_hist + 1,
		engine->rx_agc_fir_hist,
		(V8OPEN_AGC_FIR_SAMPLES - 1U) * sizeof(engine->rx_agc_fir_hist[0]));
	return (short)acc;
}

static unsigned v8_open_rx_agc_estimate_metric(const struct v8_open_engine *engine)
{
	unsigned power;
	unsigned i;

	power = 0U;
	for (i = 0U; i < V8OPEN_AGC_POWER_RING; ++i) {
		long long s;
		long long weighted;

		s = (long long)engine->rx_agc_ring[i];
		weighted = ((s * 0x38eLL) >> 15) * s;
		power += (unsigned)weighted;
	}
	if (!power)
		return 0U;

	{
		unsigned mant;
		unsigned exp;
		unsigned idx;
		unsigned metric;

		mant = power;
		exp = 0U;
		while (mant <= 0x1fffffffU) {
			mant <<= 1;
			exp++;
		}
		mant >>= 15;
		if (exp & 1U)
			mant >>= 1;
		idx = ((mant + 0x40U) >> 7) - 0x40U;
		if (idx > 0xbfU)
			idx = 0xbfU;
		metric = (unsigned)v8_open_agc_metric_lut_54e0[idx];
		metric >>= (exp >> 1);
		return metric;
	}
}

static short v8_open_rx_agc_scale_sample(struct v8_open_engine *engine, short sample)
{
	int gain;
	int product;
	unsigned top;
	short scaled;

	gain = (int)(short)engine->rx_agc_gain_q15;

	product = gain * (int)sample;
	top = ((unsigned)product) >> 25;
	if (top == 0U || top == 0x7fU) {
		scaled = (short)(product >> V8OPEN_RX_AGC_SCALE_SHIFT);
	} else {
		scaled = (short)(((product >> 16) > 0) ?
			V8OPEN_RX_AGC_SCALE_SAT_POS :
			V8OPEN_RX_AGC_SCALE_SAT_NEG);
		if (engine->ans_rx_ac < 0xffffU)
			engine->ans_rx_ac = (unsigned short)(engine->ans_rx_ac + 1U);
		if (engine->ans_rx_ac == V8OPEN_RX_AGC_SAT_COUNT_LIMIT)
			engine->rx_agc_gain_q15 = V8OPEN_RX_AGC_RECOVERY_GAIN;
	}

	return scaled;
}

static void v8_open_rx_agc_control_step(struct v8_open_engine *engine,
					unsigned block_power_hi)
{
	int level_i;
	unsigned level_top;
	int error;
	int control;
	unsigned gain;

	level_i = (int)(((long long)(short)engine->rx_agc_level * 0x6ccdLL) >> 15);
	level_i += (int)block_power_hi;
	level_top = ((unsigned)level_i) >> 15;
	if (level_top != 0U && level_top != 0x1ffffU)
		engine->rx_agc_level = 0x7f00U;
	else
		engine->rx_agc_level = (unsigned short)level_i;

	if (engine->ans_rx_0a & 0x0200U)
		return;

	error = (int)(short)engine->rx_agc_level - (int)V8OPEN_RX_AGC_LEVEL_TARGET;
	if (v8_open_abs_u32_from_i32(error) <= V8OPEN_RX_AGC_LEVEL_WINDOW)
		return;

	control = (int)(((long long)(short)engine->rx_agc_rate_q16 *
			 (long long)error) >> 16);
	control += (int)(short)engine->rx_agc_integrator;
	if (v8_open_abs_u32_from_i32(control) <= V8OPEN_RX_AGC_CONTROL_LIMIT) {
		engine->rx_agc_integrator = control;
		return;
	}

	engine->rx_agc_integrator = 0;
	gain = (unsigned short)engine->rx_agc_gain_q15;
	if (control > 0) {
		gain = (unsigned)(((unsigned long long)gain *
				   (unsigned long long)V8OPEN_RX_AGC_GAIN_DECAY_COEFF) >> 14);
	} else if (gain <= V8OPEN_RX_AGC_GAIN_GROW_LIMIT) {
		gain = (unsigned)(((unsigned long long)gain *
				   (unsigned long long)V8OPEN_RX_AGC_GAIN_GROW_COEFF) >> 14);
	}
	engine->rx_agc_gain_q15 = (unsigned short)gain;
}

static void v8_open_rx_agc_track(struct v8_open_engine *engine,
				 short metric_sample,
				 short scaled_sample)
{
	unsigned idx;
	unsigned metric;
	unsigned long long block_power;

	idx = engine->rx_agc_ring_pos % V8OPEN_AGC_POWER_RING;
	engine->rx_agc_ring[idx] = metric_sample;
	engine->rx_agc_ring_pos = (idx + 1U) % V8OPEN_AGC_POWER_RING;

	if (engine->rx_agc_block_fill < V8OPEN_AGC_BLOCK_SAMPLES)
		engine->rx_agc_block[engine->rx_agc_block_fill++] = scaled_sample;

	if (engine->rx_agc_block_fill < V8OPEN_AGC_BLOCK_SAMPLES)
		return;

	metric = v8_open_rx_agc_estimate_metric(engine);
	engine->rx_agc_metric = metric;

	block_power = 0ULL;
	for (idx = 0U; idx < V8OPEN_AGC_BLOCK_SAMPLES; ++idx) {
		long long s;

		s = (long long)engine->rx_agc_block[idx];
		block_power += (unsigned long long)(s * s);
	}
	engine->rx_agc_block_fill = 0U;
	engine->rx_agc_env = (unsigned)(block_power >> 16);

	if (metric > 0x1fU)
		v8_open_rx_agc_control_step(engine, (unsigned)(block_power >> 16));
}

static int v8_open_rx_emit_symbol_bits(struct v8_open_engine *engine,
				       unsigned short symbol_bit,
				       unsigned count)
{
	while (count-- > 0U) {
		engine->rx_c238 = (unsigned short)(engine->rx_c238 + 1U);
		engine->rx_c23a = (unsigned short)(((engine->rx_c23a << 1) |
						(symbol_bit & 0x01U)) & 0xffffU);
		engine->rx_emit_total++;
		if (v8_open_rx_push_bit(engine, symbol_bit & 0x01U))
			return 1;
	}
	return 0;
}

static void v8_open_v21_workspace_init(struct v8_open_engine *engine)
{
	if (engine->cfg.answer_mode) {
		/*
		 * Answer-side v8handshakinit takes the v8_rxinit path (not v8_V21_Init).
		 * The workspace region at +0xc22..+0xc80 is zeroed there, and +0x26 gets
		 * detector bit 0x0200 from v8_detectorinit only.
		 */
		engine->rx_c220 = 0U;
		engine->rx_c222 = 0U;
		engine->rx_c224 = 0U;
		engine->rx_c226 = 0U;
		engine->rx_c228 = 0U;
		engine->rx_c22a = 0U;
		engine->rx_c22c = 0U;
		engine->rx_c22e = 0U;
		engine->rx_c230 = 0U;
		engine->rx_c232 = 0U;
		engine->rx_c234 = 0U;
		engine->rx_c236 = 0U;
		engine->rx_c238 = 0U;
		engine->rx_c23a = 0U;
		engine->rx_c23e = 0U;
		engine->rx_c240 = 0U;
		engine->rx_c242 = 0U;
		engine->rx_c244 = 0U;
		engine->rx_c246 = 0U;
		return;
	}

	/*
	 * Originate-side v8handshakinit calls v8_V21_Init(..., 1, 0).
	 */
	engine->rx_c220 = 0U;
	engine->rx_c222 = 0x062bU;
	engine->rx_c224 = 0x0580U;
	engine->rx_c226 = 0x0020U;
	engine->rx_c228 = 0U;
	engine->rx_c22a = 0x3224U;
	engine->rx_c22c = 0x0007U;
	engine->rx_c22e = 0x0000U;
	engine->rx_c230 = 0U;
	engine->rx_c232 = 1U;
	engine->rx_c234 = 0x0018U;
	engine->rx_c236 = 0U;
	engine->rx_c238 = 0U;
	engine->rx_c23a = 0U;
	engine->rx_c23e = 0U;
	engine->rx_c240 = 0U;
	engine->rx_c242 = 0U;
	engine->rx_c244 = 0U;
	engine->rx_c246 = 0U;
	engine->ans_rx_0a = (unsigned short)(engine->ans_rx_0a | 0x8804U);
}

static void v8_open_v21_workspace_init_fsk(struct v8_open_engine *engine)
{
	/*
	 * Mirror the blob's answer receive-entry call:
	 * v8_V21_Init(..., 0, 1) in the state-0x29 path.
	 */
	engine->rx_c220 = 0U;
	engine->rx_c222 = 0x03efU;
	engine->rx_c224 = 0x0344U;
	engine->rx_c226 = 0x0020U;
	engine->rx_c228 = 0U;
	engine->rx_c22a = 0x3224U;
	engine->rx_c22c = 0x0004U;
	engine->rx_c22e = 0xff9cU;
	engine->rx_c230 = 0U;
	engine->rx_c232 = 1U;
	engine->rx_c234 = 0x0018U;
	engine->rx_c236 = 0U;
	engine->rx_c238 = 0U;
	engine->rx_c23a = 0U;
	engine->rx_c23e = 0U;
	engine->rx_c240 = 0U;
	engine->rx_c242 = 0U;
	engine->rx_c244 = 0U;
	engine->rx_c246 = 0U;
	engine->ans_rx_0a = (unsigned short)(engine->ans_rx_0a | 0x0800U);
}

static void v8_open_rx_reset_collect(struct v8_open_engine *engine)
{
	engine->rx_collect_mode = V8_OPEN_RX_COLLECT_NONE;
	engine->rx_align_locked = 0U;
	engine->rx_skip_samples = 0U;
	engine->rx_bit_window_len = 0U;
	engine->rx_shift_reg = 0U;
	engine->rx_preamble_expected = 0U;
	engine->rx_sequence_len = 0U;
	engine->rx_probe_bits = 0U;
	engine->rx_probe_words_logged = 0U;
	engine->rx_invert_bits = 0U;
	engine->rx_reverse_word_bits = 0U;
	engine->rx_word_sync = 0U;
	engine->rx_bits_to_word = 0U;
	engine->rx_demod_hist_fill = 0U;
	engine->rx_phase_offset = 0U;
	engine->rx_emit_total = 0U;
	engine->rx_agc_gain_q15 = V8OPEN_RX_AGC_INIT_GAIN;
	engine->rx_agc_env = 0U;
	engine->rx_agc_metric = 0U;
	engine->rx_agc_level = 0U;
	engine->rx_agc_integrator = 0;
	engine->rx_agc_rate_q16 = V8OPEN_RX_AGC_RATE_Q16;
	engine->rx_agc_ring_pos = 0U;
	engine->rx_agc_block_fill = 0U;
	engine->rx_dbg_low_energy = 0U;
	engine->rx_dbg_bit0 = 0U;
	engine->rx_dbg_bit1 = 0U;
	engine->rx_dbg_energy_log_counter = 0U;
	engine->rx_dbg_last_mark_e = 0;
	engine->rx_dbg_last_space_e = 0;
	engine->rx_input_dc_state = 0;
	engine->ans_rx_ac = 0U;
	memset(engine->rx_agc_ring, 0, sizeof(engine->rx_agc_ring));
	memset(engine->rx_agc_block, 0, sizeof(engine->rx_agc_block));
	memset(engine->rx_agc_fir_hist, 0, sizeof(engine->rx_agc_fir_hist));
	memset(engine->rx_demod_history, 0, sizeof(engine->rx_demod_history));
	memset(engine->rx_bit_window, 0, sizeof(engine->rx_bit_window));
	v8_open_v21_workspace_init(engine);
	engine->rx_mark_ticks = 0U;
	engine->rx_space_ticks = 0U;
	engine->cm_collect_deadline = 0U;
	engine->cj_collect_deadline = 0U;
}

static int v8_open_rx_try_lock_preamble(struct v8_open_engine *engine,
					unsigned short raw_word);

static void v8_open_rx_start_search(struct v8_open_engine *engine)
{
	v8_open_rx_reset_collect(engine);
	engine->rx_collect_mode = V8_OPEN_RX_COLLECT_SEARCH;
}

static void v8_open_rx_start_collect(struct v8_open_engine *engine,
				     enum v8_open_rx_collect_mode mode,
				     const short *samples,
				     int cnt)
{
	unsigned preserve_frontend;
	unsigned preserve_demod_state;
	unsigned preserve_agc_state;
	unsigned force_v21_reinit;
	unsigned preserved_hist_fill;
	unsigned preserved_phase_offset;
	unsigned preserved_bit_window_len;
	unsigned short preserved_shift_reg;
	unsigned short preserved_c230;
	unsigned short preserved_c232;
	unsigned short preserved_c234;
	unsigned short preserved_c236;
	unsigned short preserved_c238;
	unsigned short preserved_c23a;
	unsigned short preserved_c23e;
	unsigned short preserved_c240;
	unsigned short preserved_c242;
	unsigned short preserved_c244;
	unsigned short preserved_c246;
	unsigned preserved_mark_ticks;
	unsigned preserved_space_ticks;
	unsigned preserved_agc_gain_q15;
	unsigned preserved_agc_env;
	unsigned preserved_agc_metric;
	unsigned preserved_agc_level;
	int preserved_agc_integrator;
	unsigned preserved_agc_rate_q16;
	unsigned preserved_agc_ring_pos;
	unsigned preserved_agc_block_fill;
	short preserved_agc_ring[V8OPEN_AGC_POWER_RING];
	short preserved_agc_block[V8OPEN_AGC_BLOCK_SAMPLES];
	short preserved_agc_fir_hist[V8OPEN_AGC_FIR_SAMPLES];

	(void)samples;
	(void)cnt;

	preserve_frontend = (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_SEARCH);
	preserve_demod_state = 0U;
	preserve_agc_state = 0U;
	force_v21_reinit = 0U;
	if (engine->cfg.answer_mode && mode != V8_OPEN_RX_COLLECT_SEARCH) {
		/*
		 * In the blob answer path, v8_V21_Init is called when transitioning
		 * into receive collection (state 0x29 path), after detector setup.
		 * Do not carry SEARCH shifter/demod continuity into collection; that
		 * state is reset by V8_V21_reset. Keep AGC continuity only.
		 */
		preserve_frontend = 0U;
		preserve_demod_state = 0U;
		preserve_agc_state = 1U;
		force_v21_reinit = 1U;
	}
	preserved_hist_fill = engine->rx_demod_hist_fill;
	preserved_phase_offset = engine->rx_phase_offset;
	preserved_bit_window_len = engine->rx_bit_window_len;
	preserved_shift_reg = engine->rx_shift_reg;
	preserved_c230 = engine->rx_c230;
	preserved_c232 = engine->rx_c232;
	preserved_c234 = engine->rx_c234;
	preserved_c236 = engine->rx_c236;
	preserved_c238 = engine->rx_c238;
	preserved_c23a = engine->rx_c23a;
	preserved_c23e = engine->rx_c23e;
	preserved_c240 = engine->rx_c240;
	preserved_c242 = engine->rx_c242;
	preserved_c244 = engine->rx_c244;
	preserved_c246 = engine->rx_c246;
	preserved_mark_ticks = engine->rx_mark_ticks;
	preserved_space_ticks = engine->rx_space_ticks;
	preserved_agc_gain_q15 = engine->rx_agc_gain_q15;
	preserved_agc_env = engine->rx_agc_env;
	preserved_agc_metric = engine->rx_agc_metric;
	preserved_agc_level = engine->rx_agc_level;
	preserved_agc_integrator = engine->rx_agc_integrator;
	preserved_agc_rate_q16 = engine->rx_agc_rate_q16;
	preserved_agc_ring_pos = engine->rx_agc_ring_pos;
	preserved_agc_block_fill = engine->rx_agc_block_fill;
	memcpy(preserved_agc_ring, engine->rx_agc_ring, sizeof(preserved_agc_ring));
	memcpy(preserved_agc_block, engine->rx_agc_block, sizeof(preserved_agc_block));
	memcpy(preserved_agc_fir_hist,
	       engine->rx_agc_fir_hist,
	       sizeof(preserved_agc_fir_hist));

	engine->rx_collect_mode = mode;
	engine->rx_align_locked = 0U;
	engine->rx_skip_samples = 0U;
	engine->rx_bit_window_len = 0U;
	engine->rx_shift_reg = 0U;
	engine->rx_preamble_expected =
		mode == V8_OPEN_RX_COLLECT_CM ? 0x03ffU :
		(mode == V8_OPEN_RX_COLLECT_CJ ? 0x0155U : 0U);
	engine->rx_sequence_len = 0U;
	engine->rx_probe_bits = 0U;
	engine->rx_probe_words_logged = 0U;
	engine->rx_invert_bits = 0U;
	engine->rx_reverse_word_bits = 0U;
	engine->rx_word_sync = 0U;
	engine->rx_bits_to_word = 0U;
	engine->rx_emit_total = 0U;
	if (preserve_frontend) {
		engine->rx_demod_hist_fill = preserved_hist_fill;
		engine->rx_phase_offset = preserved_phase_offset;
		engine->rx_bit_window_len = preserved_bit_window_len;
		engine->rx_shift_reg = preserved_shift_reg;
		engine->rx_c230 = preserved_c230;
		engine->rx_c232 = preserved_c232;
		engine->rx_c234 = preserved_c234;
		engine->rx_c236 = preserved_c236;
		engine->rx_c238 = preserved_c238;
		engine->rx_c23a = preserved_c23a;
		engine->rx_c23e = preserved_c23e;
		engine->rx_c240 = preserved_c240;
		engine->rx_c242 = preserved_c242;
		engine->rx_c244 = preserved_c244;
		engine->rx_c246 = preserved_c246;
		engine->rx_mark_ticks = preserved_mark_ticks;
		engine->rx_space_ticks = preserved_space_ticks;
		engine->rx_agc_gain_q15 = preserved_agc_gain_q15;
		engine->rx_agc_env = preserved_agc_env;
		engine->rx_agc_metric = preserved_agc_metric;
		engine->rx_agc_level = preserved_agc_level;
		engine->rx_agc_integrator = preserved_agc_integrator;
		engine->rx_agc_rate_q16 = preserved_agc_rate_q16;
		engine->rx_agc_ring_pos = preserved_agc_ring_pos;
		engine->rx_agc_block_fill = preserved_agc_block_fill;
		memcpy(engine->rx_agc_ring, preserved_agc_ring, sizeof(engine->rx_agc_ring));
		memcpy(engine->rx_agc_block, preserved_agc_block, sizeof(engine->rx_agc_block));
		memcpy(engine->rx_agc_fir_hist,
		       preserved_agc_fir_hist,
		       sizeof(engine->rx_agc_fir_hist));
		if (!v8_open_rx_try_lock_preamble(
				engine,
				(unsigned short)(engine->rx_c23a & 0x0fffU))) {
			v8_open_rx_try_lock_preamble(
				engine,
				(unsigned short)(engine->rx_shift_reg & 0x0fffU));
		}
	} else {
		if (preserve_demod_state) {
			engine->rx_demod_hist_fill = preserved_hist_fill;
			engine->rx_phase_offset = preserved_phase_offset;
			engine->rx_bit_window_len = preserved_bit_window_len;
		} else {
			engine->rx_demod_hist_fill = 0U;
			engine->rx_phase_offset = 0U;
		}
			/*
			 * Mirror blob answer receive-entry behavior: when moving
			 * from detector/search into CM/CJ collection, re-run the
			 * V.21 receive init path (v8_V21_Init(...,0,1) analogue).
			 *
			 * FSK init sets use_alt_bank base=1 (via rx_c22c/rx_c22e).
			 * Reset demod profile to 0 so the first collection attempt
			 * uses the correct alt bank (980/1180 Hz for V.21 ch1).
			 * Without this, an odd profile carried from SEARCH mode
			 * would flip the bank selection to the wrong frequencies.
			 */
			if (force_v21_reinit) {
				v8_open_v21_workspace_init_fsk(engine);
				engine->rx_demod_profile = 0U;
			} else
				v8_open_v21_workspace_init(engine);
		if (preserve_demod_state) {
			engine->rx_mark_ticks = preserved_mark_ticks;
			engine->rx_space_ticks = preserved_space_ticks;
		} else {
			engine->rx_mark_ticks = 0U;
			engine->rx_space_ticks = 0U;
		}
		if (preserve_demod_state || preserve_agc_state) {
			engine->rx_agc_gain_q15 = preserved_agc_gain_q15;
			engine->rx_agc_env = preserved_agc_env;
			engine->rx_agc_metric = preserved_agc_metric;
			engine->rx_agc_level = preserved_agc_level;
			engine->rx_agc_integrator = preserved_agc_integrator;
			engine->rx_agc_rate_q16 = preserved_agc_rate_q16;
			engine->rx_agc_ring_pos = preserved_agc_ring_pos;
			engine->rx_agc_block_fill = preserved_agc_block_fill;
			memcpy(engine->rx_agc_ring, preserved_agc_ring, sizeof(engine->rx_agc_ring));
			memcpy(engine->rx_agc_block, preserved_agc_block, sizeof(engine->rx_agc_block));
			memcpy(engine->rx_agc_fir_hist,
			       preserved_agc_fir_hist,
			       sizeof(engine->rx_agc_fir_hist));
		} else {
			engine->rx_agc_gain_q15 = V8OPEN_RX_AGC_INIT_GAIN;
			engine->rx_agc_env = 0U;
			engine->rx_agc_metric = 0U;
			engine->rx_agc_level = 0U;
			engine->rx_agc_integrator = 0;
			engine->rx_agc_rate_q16 = V8OPEN_RX_AGC_RATE_Q16;
			engine->rx_agc_ring_pos = 0U;
			engine->rx_agc_block_fill = 0U;
			engine->ans_rx_ac = 0U;
			memset(engine->rx_agc_ring, 0, sizeof(engine->rx_agc_ring));
			memset(engine->rx_agc_block, 0, sizeof(engine->rx_agc_block));
			memset(engine->rx_agc_fir_hist, 0, sizeof(engine->rx_agc_fir_hist));
		}
		/*
		 * Blob state transition to receive-collect does not replay
		 * the current fragment through a freshly reset V.21 chain.
		 * Start consuming from subsequent process calls.
		 */
	}
}

static int v8_open_cj_sequence_valid(struct v8_open_engine *engine);

static unsigned v8_open_pcm_negotiation_usable(const struct v8_open_engine *engine)
{
	if (!engine)
		return 0U;

	/*
	 * In open-stub deployments on analog side, treating raw PCM-category
	 * hits as valid CM evidence creates frequent false positives and
	 * cascades into no-CJ fallbacks. Only trust PCM when digital access
	 * and digital PCM are explicitly enabled.
	 */
	if (!engine->cfg.advertise.access_digital ||
	    !engine->cfg.advertise.pcm_digital)
		return 0U;
	if (!engine->cfg.advertise.v90 &&
	    !engine->cfg.advertise.v92)
		return 0U;
	return 1U;
}

static int v8_open_cm_sequence_valid(struct v8_open_engine *engine)
{
	unsigned cap_matches;
	unsigned pcm_usable;
	unsigned high_speed;
	unsigned short sig[3];
	unsigned sig_len;
	unsigned short call_word;
	unsigned short proto_word;

	if (!engine)
		return 0;

	pcm_usable = v8_open_pcm_negotiation_usable(engine);

	cap_matches = 0U;
	if (engine->remote_v34)
		cap_matches++;
	if (engine->remote_v32)
		cap_matches++;
	if (engine->remote_pcm_present && pcm_usable)
		cap_matches++;
	if (engine->remote_access_present)
		cap_matches++;
	/*
	 * Require V.34-or-higher capability before accepting CM as handshake
	 * completion evidence.
	 */
	high_speed = engine->remote_v34 ||
		(engine->remote_pcm_present && pcm_usable);
	if (!high_speed)
		return 0;

	/*
	 * Protocol token (e.g. LAPM) is optional in CM; accept CM when the
	 * call-function token is present with any negotiated capability.
	 */
	if (engine->have_call_match) {
		if (engine->have_proto_match)
			goto cm_validated;
		if (cap_matches > 0U)
			goto cm_validated;
		return 0;
	}

	/*
	 * Require an explicit call-function match. Do not accept CM from
	 * category-only or weak/framing-tolerant evidence.
	 */
	return 0;

cm_validated:
	if (engine->rx_seq_b_count < 5U)
		return 0;

	/*
	 * Compare a canonical CM identity instead of raw sliding words. The
	 * raw window length/content shifts (5/6/7...) while demod aligns, which
	 * should not reset identical-sequence confirmation.
	 */
	call_word = engine->matched_call_word ?
		engine->matched_call_word :
		v8_open_find_rx_token(engine, 0x0101U, 0U);
	proto_word = engine->matched_proto_word ?
		engine->matched_proto_word :
		v8_open_find_rx_token(engine, 0x00a1U, 0U);
	sig[0] = call_word;
	sig[1] = proto_word;
	sig[2] = (unsigned short)((engine->remote_v34 ? 0x0001U : 0U) |
				  (engine->remote_v32 ? 0x0002U : 0U) |
				  (engine->remote_pcm_present ? 0x0004U : 0U) |
				  (engine->remote_access_present ? 0x0008U : 0U) |
				  (engine->have_call_match ? 0x0010U : 0U) |
				  (engine->have_proto_match ? 0x0020U : 0U));
	sig_len = (unsigned)(sizeof(sig) / sizeof(sig[0]));

	if (engine->cm_confirm_valid_count == 0U ||
	    engine->cm_confirm_word_count != sig_len ||
	    memcmp(engine->cm_confirm_seq,
		   sig,
		   sig_len * sizeof(engine->cm_confirm_seq[0])) != 0) {
		memcpy(engine->cm_confirm_seq,
		       sig,
		       sig_len * sizeof(engine->cm_confirm_seq[0]));
		engine->cm_confirm_word_count = sig_len;
		engine->cm_confirm_valid_count = 1U;
		V8OPEN_DBG("cm-stub: confirmed valid CM 1/%u (V.34+), waiting for identical repeat words=%u\n",
			  V8OPEN_CM_CONFIRM_IDENTICAL_MIN,
			  engine->rx_seq_b_count > V8OPEN_CM_WORDS ?
			  V8OPEN_CM_WORDS : engine->rx_seq_b_count);
		return 0;
	}

	if (engine->cm_confirm_valid_count < 0xffffU)
		engine->cm_confirm_valid_count++;
	if (engine->cm_confirm_valid_count < V8OPEN_CM_CONFIRM_IDENTICAL_MIN)
		return 0;
	V8OPEN_DBG("cm-stub: confirmed valid CM %u/%u (identical V.34+ sequence)\n",
		  engine->cm_confirm_valid_count,
		  V8OPEN_CM_CONFIRM_IDENTICAL_MIN);

	return 1;
}

static unsigned short v8_open_rx_normalize_word(const struct v8_open_engine *engine,
						unsigned short raw_word)
{
	unsigned short word;

	word = raw_word;
	if (engine->rx_reverse_word_bits)
		word = v8_open_reverse_word10(word);
	if (engine->rx_invert_bits)
		word ^= 0x03ffU;
	return word;
}

static void v8_open_rx_seed_sync_sequence(struct v8_open_engine *engine)
{
	if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM) {
		engine->rx_seq_b_count = 0U;
		engine->cm_collect_index = 0U;
		engine->cm_collect_pass = 0U;
		engine->cm_even_words = 0U;
		engine->rx_sequence_len = 0U;
	} else if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CJ) {
		engine->rx_seq_a_count = 0U;
		engine->cj_collect_index = 0U;
	}
}

static int v8_open_rx_try_lock_preamble(struct v8_open_engine *engine,
					unsigned short raw_word)
{
	unsigned raw10;
	unsigned inv_word;
	unsigned rev_word;
	unsigned rev_inv_word;
	unsigned preamble_expected;
	unsigned preamble_alt;
	unsigned match_raw;
	unsigned match_inv;
	unsigned match_rev;
	unsigned match_rinv;
	const char *orient;

	raw10 = raw_word & 0x03ffU;
	inv_word = raw10 ^ 0x03ffU;
	rev_word = v8_open_reverse_word10((unsigned short)raw10);
	rev_inv_word = rev_word ^ 0x03ffU;
	preamble_expected = engine->rx_preamble_expected;
	preamble_alt = 0U;
	if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CJ)
		preamble_alt = 0x03ffU;
	match_raw = (raw10 == preamble_expected) ||
		(preamble_alt && raw10 == preamble_alt);
	match_inv = (inv_word == preamble_expected) ||
		(preamble_alt && inv_word == preamble_alt);
	match_rev = (rev_word == preamble_expected) ||
		(preamble_alt && rev_word == preamble_alt);
	match_rinv = (rev_inv_word == preamble_expected) ||
		(preamble_alt && rev_inv_word == preamble_alt);

	if (!match_raw && !match_inv && !match_rev && !match_rinv)
		return 0;

	/*
	 * CM preamble (all-1/all-0) is orientation-ambiguous. Alternate the
	 * orientation family across retries to avoid getting stuck decoding with
	 * a consistently wrong bit order.
	 */
	if ((match_raw || match_inv) &&
	    (match_rev || match_rinv) &&
	    (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM)) {
		if (engine->rx_orient_flip & 1U) {
			if (match_rev) {
				engine->rx_reverse_word_bits = 1U;
				engine->rx_invert_bits = 0U;
				orient = "rev";
			} else {
				engine->rx_reverse_word_bits = 1U;
				engine->rx_invert_bits = 1U;
				orient = "rinv";
			}
		} else {
			if (match_raw) {
				engine->rx_reverse_word_bits = 0U;
				engine->rx_invert_bits = 0U;
				orient = "raw";
			} else {
				engine->rx_reverse_word_bits = 0U;
				engine->rx_invert_bits = 1U;
				orient = "inv";
			}
		}
	} else if (match_raw) {
		engine->rx_reverse_word_bits = 0U;
		engine->rx_invert_bits = 0U;
		orient = "raw";
	} else if (match_inv) {
		engine->rx_reverse_word_bits = 0U;
		engine->rx_invert_bits = 1U;
		orient = "inv";
	} else if (match_rev) {
		engine->rx_reverse_word_bits = 1U;
		engine->rx_invert_bits = 0U;
		orient = "rev";
	} else {
		engine->rx_reverse_word_bits = 1U;
		engine->rx_invert_bits = 1U;
		orient = "rinv";
	}

	/*
	 * CM preamble can lock at any bit phase while the stream is all 1s.
	 * When framing stalls, rotate this skip count to force the next lock
	 * onto a different 10-bit phase candidate.
	 */
	if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM &&
	    engine->rx_lock_skip_bits > 0U) {
		engine->rx_lock_skip_bits--;
		return 0;
	}

	engine->rx_probe_bits = 0U;
	engine->rx_word_sync = 1U;
	engine->rx_bits_to_word = 0U;
	engine->rx_shift_reg = (unsigned short)raw10;
	v8_open_rx_seed_sync_sequence(engine);
	V8OPEN_DBG("rx-lock: mode=%s preamble=%03x orient=%s c23a=%03x runs=%u/%u/%u\n",
		  engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM ? "cm" : "cj",
		  preamble_expected,
		  orient,
		  (unsigned)(engine->rx_c23a & 0x0fffU),
		  engine->rx_c23e,
		  engine->rx_c240,
		  engine->rx_c242);
	return 1;
}

static void v8_open_cm_advance_phase_scan(struct v8_open_engine *engine)
{
	if (!engine)
		return;
	engine->rx_phase_scan_index = (engine->rx_phase_scan_index + 1U) % 10U;
	engine->rx_lock_skip_bits = engine->rx_phase_scan_index;
	engine->rx_orient_flip ^= 1U;
}

static int v8_open_rx_update_runs(struct v8_open_engine *engine, unsigned bit)
{
	if (bit & 0x01U) {
		engine->rx_c23e = 0U;
		engine->rx_c240 = (unsigned short)(engine->rx_c240 + 1U);
		engine->rx_c242 = engine->rx_c240;
		return 0;
	}

	engine->rx_c23e = (unsigned short)(engine->rx_c23e + 1U);
	if (engine->rx_c23e == 6U) {
		if (engine->rx_c242 > 9U) {
			unsigned short framed_index;

			framed_index = engine->rx_c244;
			engine->rx_c244 = (unsigned short)(framed_index + 1U);
			engine->rx_c246 = framed_index;
			engine->rx_c240 = 0U;
			return 1;
		}
	}

	engine->rx_c240 = 0U;
	return 0;
}

static int v8_open_rx_push_bit(struct v8_open_engine *engine, unsigned bit)
{
	unsigned raw_word;
	unsigned inv_word;
	unsigned rev_word;
	unsigned rev_inv_word;
	unsigned short word;

	/*
	 * Track the blob run/framing counters (+0xc3e/+0xc40/+0xc42/+0xc44/+0xc46)
	 * on every demodulated bit.
	 */
	(void)v8_open_rx_update_runs(engine, bit);
	engine->rx_shift_reg = (unsigned short)(((engine->rx_shift_reg << 1) |
						(bit & 0x01U)) & 0xffffU);

	if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_SEARCH) {
		return 0;
	}

	raw_word = (unsigned short)(engine->rx_shift_reg & 0x03ffU);
	inv_word = raw_word ^ 0x03ffU;
	rev_word = v8_open_reverse_word10(raw_word);
	rev_inv_word = rev_word ^ 0x03ffU;

	if (!engine->rx_word_sync) {
		engine->rx_probe_bits++;
		if (engine->rx_probe_words_logged < 6U) {
			V8OPEN_DBG("rx-probe: mode=%s raw=%03x inv=%03x rev=%03x rinv=%03x runs=%u/%u/%u mark=%u delim=%u\n",
				  engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM ? "cm" : "cj",
				  raw_word,
				  inv_word,
				  rev_word,
				  rev_inv_word,
				  engine->rx_c23e,
				  engine->rx_c240,
				  engine->rx_c242,
				  engine->rx_c244,
				  engine->rx_c246);
			engine->rx_probe_words_logged++;
		}

		/*
		 * Full framing search: probe the rolling 10-bit window every bit
		 * until preamble lock, then start aligned 10-bit word collection.
		 */
		if (v8_open_rx_try_lock_preamble(engine, raw_word)) {
			engine->rx_bits_to_word = 0U;
			engine->rx_c238 = 0U;
		}
		return 0;
	}

	engine->rx_bits_to_word++;
	if (engine->rx_bits_to_word < 10U)
		return 0;
	engine->rx_bits_to_word = 0U;
	engine->rx_c238 = 0U;

	/*
	 * Blob receive states consume 10-bit words from the live V.21 shifter
	 * once aligned; `rx_shift_reg` holds the active rolling 10-bit word.
	 */
	word = v8_open_rx_normalize_word(engine, raw_word);
	if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM) {
		if (engine->cm_collect_index < 12U) {
			V8OPEN_DBG("rx-word: mode=cm idx=%u raw=%03x norm=%03x seq_len=%u pass=%u runs=%u/%u/%u\n",
				  engine->cm_collect_index,
				  (unsigned)raw_word,
				  (unsigned)word,
				  (unsigned)engine->rx_sequence_len,
				  (unsigned)engine->cm_collect_pass,
				  engine->rx_c23e,
				  engine->rx_c240,
				  engine->rx_c242);
		}
	} else if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CJ) {
		if (engine->cj_collect_index < 8U) {
			V8OPEN_DBG("rx-word: mode=cj idx=%u raw=%03x norm=%03x runs=%u/%u/%u\n",
				  engine->cj_collect_index,
				  (unsigned)raw_word,
				  (unsigned)word,
				  engine->rx_c23e,
				  engine->rx_c240,
				  engine->rx_c242);
		}
	}
	if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CM) {
		if (engine->cm_collect_index < V8OPEN_CM_WORDS) {
			engine->rx_seq_b[engine->cm_collect_index++] = word;
		} else {
			memmove(engine->rx_seq_b,
				engine->rx_seq_b + 1,
				(V8OPEN_CM_WORDS - 1U) * sizeof(engine->rx_seq_b[0]));
			engine->rx_seq_b[V8OPEN_CM_WORDS - 1U] = word;
			engine->cm_collect_index++;
		}
			if (word != 0x03ffU)
				engine->cm_collect_pass++;
			if (word != 0x03ffU && ((word & 0x0001U) == 0U))
				engine->cm_even_words++;
			engine->rx_seq_b_count = engine->cm_collect_index < V8OPEN_CM_WORDS ?
				engine->cm_collect_index : V8OPEN_CM_WORDS;
			if (engine->rx_seq_b_count >= 4U &&
			    (engine->cm_collect_pass > engine->cm_best_pass ||
			     (engine->cm_collect_pass == engine->cm_best_pass &&
			      engine->rx_seq_b_count > engine->cm_best_count))) {
				engine->cm_best_pass = engine->cm_collect_pass;
				engine->cm_best_count = engine->rx_seq_b_count;
				memcpy(engine->cm_best_seq,
				       engine->rx_seq_b,
				       engine->cm_best_count * sizeof(engine->cm_best_seq[0]));
			}
		if (engine->rx_seq_b_count >= 5U) {
			v8_open_parse_rx_sequence(engine);
			if (v8_open_cm_sequence_valid(engine))
				return 1;
		}
	} else if (engine->rx_collect_mode == V8_OPEN_RX_COLLECT_CJ) {
		unsigned cj_valid;

		if (engine->cj_collect_index < V8OPEN_CJ_WORDS) {
			engine->rx_seq_a[engine->cj_collect_index++] = word;
		} else {
			memmove(engine->rx_seq_a,
				engine->rx_seq_a + 1,
				(V8OPEN_CJ_WORDS - 1U) * sizeof(engine->rx_seq_a[0]));
			engine->rx_seq_a[V8OPEN_CJ_WORDS - 1U] = word;
			engine->cj_collect_index++;
		}

		engine->rx_seq_a_count = engine->cj_collect_index < V8OPEN_CJ_WORDS ?
			engine->cj_collect_index : V8OPEN_CJ_WORDS;
		cj_valid = 0U;
		if (engine->rx_seq_a_count >= 3U)
			cj_valid = v8_open_cj_sequence_valid(engine);
		if (cj_valid)
			return 1;
		if (engine->cj_collect_index >= V8OPEN_CJ_INVALID_RELOCK_WORDS &&
		    (engine->cj_collect_index % 32U) == 0U) {
			V8OPEN_DBG("cj-stub: still scanning CJ idx=%u raw=%03x norm=%03x runs=%u/%u/%u\n",
				  engine->cj_collect_index,
				  (unsigned)raw_word,
				  (unsigned)word,
				  engine->rx_c23e,
				  engine->rx_c240,
				  engine->rx_c242);
		}
	}

	return 0;
}

static int v8_open_rx_consume_samples(struct v8_open_engine *engine,
				      const short *samples,
				      int cnt)
{
	const short *filt_dd8;
	const short *filt_ddc;
	const short *filt_de0;
	const short *filt_de4;
	unsigned use_alt_bank;
	unsigned i;

	if (!samples || cnt <= 0)
		return 0;

	use_alt_bank = (engine && engine->rx_c22c == 0x0004U && engine->rx_c22e == 0xff9cU) ?
		1U : 0U;
	if (engine && (engine->rx_demod_profile & 0x01U))
		use_alt_bank ^= 1U;

	if (use_alt_bank) {
		filt_dd8 = v8_open_v21_filt_5b20;
		filt_ddc = v8_open_v21_filt_5ac0;
		filt_de0 = v8_open_v21_filt_5be0;
		filt_de4 = v8_open_v21_filt_5b80;
	} else {
		filt_dd8 = v8_open_v21_filt_1;
		filt_ddc = v8_open_v21_filt_0;
		filt_de0 = v8_open_v21_filt_3;
		filt_de4 = v8_open_v21_filt_2;
	}

	for (i = 0U; i < (unsigned)cnt; ++i) {
		short fir_sample;
		short demod_sample;

		fir_sample = v8_open_rx_agc_prefilter_sample(engine, samples[i]);
		demod_sample = v8_open_rx_agc_scale_sample(engine, fir_sample);
		v8_open_rx_agc_track(engine, fir_sample, demod_sample);

		engine->rx_bit_window[engine->rx_bit_window_len++] = samples[i];
		if (engine->rx_bit_window_len < V8OPEN_DEMOD_STAGE_SAMPLES)
			continue;

		{
			unsigned phase_sched;
			unsigned idx;
			phase_sched = engine->rx_phase_offset;
			for (idx = 0U; idx < V8OPEN_DEMOD_STAGE_SAMPLES; ++idx) {
				int mark_energy;
				int space_energy;
				unsigned bit;
				int acc0;
				int acc1;
				int acc2;
				int acc3;
				unsigned tap;

				if (phase_sched > idx)
					continue;

				phase_sched += 8U;
				acc0 = 0x2000;
				acc1 = 0x2000;
				acc2 = 0x2000;
				acc3 = 0x2000;
				for (tap = 0U; tap < V8OPEN_DEMOD_HISTORY_SAMPLES; ++tap) {
					short s;

					if (tap <= idx) {
						s = engine->rx_bit_window[idx - tap];
					} else {
						unsigned h;

						h = V8OPEN_DEMOD_HISTORY_SAMPLES + idx - tap;
						s = engine->rx_demod_history[h];
					}
					acc0 += (int)s * (int)filt_dd8[tap];
					acc1 += (int)s * (int)filt_ddc[tap];
					acc2 += (int)s * (int)filt_de0[tap];
					acc3 += (int)s * (int)filt_de4[tap];
				}
				{
					short f0;
					short f1;
					short f2;
					short f3;
					int e0;
					int e1;
					int e2;
					int e3;

					/* Blob v8_fskdemodulate truncates each filtered branch to s16. */
					f0 = (short)(acc0 >> 14);
					f1 = (short)(acc1 >> 14);
					f2 = (short)(acc2 >> 14);
					f3 = (short)(acc3 >> 14);
					e0 = (int)f0 * (int)f0;
					e1 = (int)f1 * (int)f1;
					e2 = (int)f2 * (int)f2;
					e3 = (int)f3 * (int)f3;
					mark_energy = e0 + e1;
					space_energy = e2 + e3;
					/*
					 * Blob v8_fskdemodulate uses signed
					 * subtraction: bit is set when
					 * (space_energy - mark_energy) > 0.
					 * Both energies are signed int in the blob.
					 */
					bit = (space_energy - mark_energy) > 0 ? 1U : 0U;
					engine->rx_dbg_last_mark_e = mark_energy;
					engine->rx_dbg_last_space_e = space_energy;
					engine->rx_dbg_energy_log_counter++;
					if ((engine->rx_dbg_energy_log_counter & 0x7fU) == 1U)
						V8OPEN_DBG("demod-energy: mark=%d space=%d diff=%d bit=%u f0=%d f1=%d f2=%d f3=%d prof=%u alt=%u\n",
							  mark_energy, space_energy,
							  space_energy - mark_energy,
							  bit, (int)f0, (int)f1, (int)f2, (int)f3,
							  engine->rx_demod_profile,
							  use_alt_bank);
					/*
					 * Profile bit1 enables polarity scan so timeout
					 * rearms can explore both mark/space mappings.
					 */
					if (engine && (engine->rx_demod_profile & 0x02U))
						bit ^= 1U;
				}

				if (mark_energy < V8OPEN_DEMOD_ENERGY_FLOOR &&
				    space_energy < V8OPEN_DEMOD_ENERGY_FLOOR) {
					engine->rx_dbg_low_energy++;
					/*
					 * Blob v8_fskdemodulate clears BOTH tick
					 * counters when energy is below the floor
					 * (0x78e7f-0x78e8d).  This prevents noise
					 * during silence from corrupting subsequent
					 * bit detection.
					 */
					engine->rx_mark_ticks = 0U;
					engine->rx_space_ticks = 0U;
					continue;
				}

				if (bit) {
					/* bit=1: (space-mark) > 0 in blob demod. */
					engine->rx_dbg_bit1++;
					unsigned emit_count;

					/* Flush prior bit=0 run with c230 symbol. */
					emit_count =
						v8_open_rx_quantize_transition_clear(&engine->rx_mark_ticks);
					if (emit_count)
						if (v8_open_rx_emit_symbol_bits(engine,
										 engine->rx_c230,
										 emit_count))
							return 1;
					engine->rx_space_ticks++;
				} else {
					/* bit=0: (space-mark) <= 0 in blob demod. */
					engine->rx_dbg_bit0++;
					unsigned emit_count;

					/* Flush prior bit=1 run with c232 symbol. */
					emit_count =
						v8_open_rx_quantize_transition_clear(&engine->rx_space_ticks);
					if (emit_count)
						if (v8_open_rx_emit_symbol_bits(engine,
										 engine->rx_c232,
										 emit_count))
							return 1;
					engine->rx_mark_ticks++;
				}
			}

			{
				unsigned emit_count;

				emit_count = v8_open_rx_quantize_block_flush(&engine->rx_mark_ticks);
				if (emit_count)
					if (v8_open_rx_emit_symbol_bits(engine,
									engine->rx_c230,
									emit_count))
						return 1;

				emit_count = v8_open_rx_quantize_block_flush(&engine->rx_space_ticks);
				if (emit_count)
					if (v8_open_rx_emit_symbol_bits(engine,
									engine->rx_c232,
									emit_count))
						return 1;
			}

			engine->rx_phase_offset =
				phase_sched >= V8OPEN_DEMOD_STAGE_SAMPLES ?
					(phase_sched - V8OPEN_DEMOD_STAGE_SAMPLES) : 0U;
			if (engine->rx_demod_hist_fill < V8OPEN_DEMOD_HISTORY_SAMPLES) {
				engine->rx_demod_hist_fill += V8OPEN_DEMOD_STAGE_SAMPLES;
				if (engine->rx_demod_hist_fill > V8OPEN_DEMOD_HISTORY_SAMPLES)
					engine->rx_demod_hist_fill = V8OPEN_DEMOD_HISTORY_SAMPLES;
			}
			memmove(engine->rx_demod_history,
				engine->rx_demod_history + V8OPEN_DEMOD_STAGE_SAMPLES,
				(V8OPEN_DEMOD_HISTORY_SAMPLES - V8OPEN_DEMOD_STAGE_SAMPLES) *
					sizeof(engine->rx_demod_history[0]));
			memcpy(engine->rx_demod_history +
			       (V8OPEN_DEMOD_HISTORY_SAMPLES - V8OPEN_DEMOD_STAGE_SAMPLES),
			       engine->rx_bit_window,
			       V8OPEN_DEMOD_STAGE_SAMPLES * sizeof(engine->rx_bit_window[0]));
		}
		engine->rx_bit_window_len = 0U;
	}

	return 0;
}

static short v8_open_rx_frontend_sample(struct v8_open_engine *engine, short sample)
{
	int prev;
	int mixed;
	int state;

	/*
	 * Blob V8Process front-end sample path (around 0x745d9):
	 *   mixed = (s + state) as signed 16-bit
	 *   state = (((mixed * 0x0f85) - (s << 12)) >> 12) as signed 16-bit
	 *   queue mixed into V.8 receive chain
	 */
	prev = (int)engine->rx_input_dc_state;
	mixed = (int)(short)(sample + (short)prev);
	state = (((mixed * 0x0f85) - ((int)sample << 12)) >> 12);
	engine->rx_input_dc_state = (short)state;
	return (short)mixed;
}

static void v8_open_cm_collect_start(struct v8_open_engine *engine,
				     const short *samples,
				     int cnt)
{
	unsigned samples_per_bit;
	unsigned words_budget;

	engine->cm_collecting = 1U;
	engine->cm_collect_index = 0U;
	engine->cm_collect_pass = 0U;
	engine->cm_even_words = 0U;
	engine->rx_seq_b_count = 0U;
	engine->rx_token_count = 0U;
	memset(engine->rx_seq_b, 0, sizeof(engine->rx_seq_b));
	memset(engine->rx_tokens, 0, sizeof(engine->rx_tokens));
	samples_per_bit = v8_open_rx_samples_per_bit(engine);
	words_budget = (engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CM) ?
		V8OPEN_CM_COLLECT_WORDS_WAIT : V8OPEN_CM_COLLECT_WORDS_LONG;
	engine->cm_collect_deadline = engine->samples_in_phase +
		(words_budget * 10U * samples_per_bit);
	v8_open_rx_start_collect(engine, V8_OPEN_RX_COLLECT_CM, samples, cnt);
	v8_open_rx_seed_sync_sequence(engine);
}

static void v8_open_cm_recovery_rearm(struct v8_open_engine *engine,
				      unsigned advance_phase_scan)
{
	if (!engine)
		return;
	engine->cm_collecting = 0U;
	engine->cm_collect_deadline = 0U;
	engine->cm_collect_index = 0U;
	engine->cm_collect_pass = 0U;
	engine->cm_even_words = 0U;
	engine->rx_demod_profile =
		(unsigned)((engine->rx_demod_profile + 1U) & 0x03U);
	if (advance_phase_scan)
		v8_open_cm_advance_phase_scan(engine);
	v8_open_rx_start_search(engine);
	v8_open_answer_predetector_arm(engine);
	engine->cm_predetecting = 1U;
	engine->cm_predetect_deadline = 0U;
}

static int v8_open_try_salvage_best_cm(struct v8_open_engine *engine)
{
	unsigned short saved_seq[V8OPEN_CM_WORDS];
	unsigned saved_count;
	unsigned max_shift;
	unsigned shift;
	unsigned i;

	if (!engine || engine->cm_best_count < 4U)
		return 0;

	saved_count = engine->rx_seq_b_count;
	for (i = 0U; i < V8OPEN_CM_WORDS; ++i)
		saved_seq[i] = engine->rx_seq_b[i];

	max_shift = (engine->cm_best_count > 4U) ? (engine->cm_best_count - 4U) : 0U;
	if (max_shift > 6U)
		max_shift = 6U;

	for (shift = 0U; shift <= max_shift; ++shift) {
		unsigned candidate_count;
		unsigned cap_matches;
		unsigned accepted;

		candidate_count = engine->cm_best_count - shift;
		engine->rx_seq_b_count = candidate_count;
		for (i = 0U; i < candidate_count; ++i)
			engine->rx_seq_b[i] = engine->cm_best_seq[i + shift];
		for (; i < V8OPEN_CM_WORDS; ++i)
			engine->rx_seq_b[i] = 0U;

		v8_open_parse_rx_sequence(engine);

		cap_matches = 0U;
		if (engine->remote_v34)
			cap_matches++;
		if (engine->remote_v32)
			cap_matches++;
		if (engine->remote_pcm_present &&
		    v8_open_pcm_negotiation_usable(engine))
			cap_matches++;
		if (engine->remote_access_present)
			cap_matches++;

		{
			unsigned modulation_matches;
			unsigned pcm_usable;

			pcm_usable = v8_open_pcm_negotiation_usable(engine);
			modulation_matches = 0U;
			if (engine->remote_v34)
				modulation_matches++;
			if (engine->remote_v32)
				modulation_matches++;
			if (engine->remote_pcm_present && pcm_usable)
				modulation_matches++;

			accepted = 0U;
			if (v8_open_cm_sequence_valid(engine))
				accepted = 1U;
			else if (engine->remote_call_data &&
				 (engine->have_proto_match ||
				  modulation_matches >= 1U ||
				  (cap_matches >= 2U && engine->rx_token_count >= 4U)))
				accepted = 1U;
			else if (engine->rx_token_count >= 4U &&
				 modulation_matches >= 1U &&
				 cap_matches >= 2U)
				accepted = 1U;
		}

		if (accepted) {
			V8OPEN_DBG("cm-stub: salvage accepted best window pass=%u shift=%u words=%u tokens=%u remote=data:%u v34:%u v32:%u pcm:%u access:%u proto=%u\n",
				  engine->cm_best_pass,
				  shift,
				  candidate_count,
				  engine->rx_token_count,
				  engine->remote_call_data,
				  engine->remote_v34,
				  engine->remote_v32,
				  engine->remote_pcm_present,
				  engine->remote_access_present,
				  engine->have_proto_match);
			return 1;
		}
	}

	V8OPEN_DBG("cm-stub: salvage rejected best window pass=%u words=%u tokens=%u remote=data:%u v34:%u v32:%u pcm:%u access:%u proto=%u\n",
		  engine->cm_best_pass,
		  engine->cm_best_count,
		  engine->rx_token_count,
		  engine->remote_call_data,
		  engine->remote_v34,
		  engine->remote_v32,
		  engine->remote_pcm_present,
		  engine->remote_access_present,
		  engine->have_proto_match);

	engine->rx_seq_b_count = saved_count;
	for (i = 0U; i < V8OPEN_CM_WORDS; ++i)
		engine->rx_seq_b[i] = saved_seq[i];
	return 0;
}

static void v8_open_cj_collect_start(struct v8_open_engine *engine,
				     const short *samples,
				     int cnt)
{
	engine->cj_collecting = 1U;
	engine->cj_collect_index = 0U;
	engine->rx_seq_a_count = 0U;
	engine->cj_sequence_valid = 0U;
	engine->cj_variant_bit = 0U;
	memset(engine->rx_seq_a, 0, sizeof(engine->rx_seq_a));
	/* Keep CJ collection continuous across ANS_WAIT_FOR_CJ. */
	engine->cj_collect_deadline = 0U;
	v8_open_rx_start_collect(engine, V8_OPEN_RX_COLLECT_CJ, samples, cnt);
	v8_open_rx_seed_sync_sequence(engine);
}

static int v8_open_cj_sequence_valid(struct v8_open_engine *engine)
{
	unsigned zero_run;
	unsigned max_zero_run;
	unsigned i;

	if (engine->rx_seq_a_count < 3U)
		return 0;

	zero_run = 0U;
	max_zero_run = 0U;
	for (i = 0U; i < engine->rx_seq_a_count; ++i) {
		unsigned short cj_word;

		cj_word = (unsigned short)(engine->rx_seq_a[i] & 0x03ffU);
		/* CJ is continuous mark — appears as all-zeros or all-ones
		   depending on orientation. Accept both patterns. */
		if ((cj_word & 0x03feU) == 0x0000U ||
		    (cj_word & 0x03feU) == 0x03feU) {
			zero_run++;
			if (zero_run > max_zero_run)
				max_zero_run = zero_run;
		} else {
			zero_run = 0U;
		}
	}

	if (max_zero_run < 3U)
		return 0;

	engine->cj_sequence_valid = 1U;
	engine->cj_variant_bit = 0U;
	V8OPEN_DBG("cj-stub: accepted uniform CJ run run=%u words=%u\n",
		  max_zero_run,
		  engine->rx_seq_a_count);
	return 1;
}

static void v8_open_parse_rx_sequence_words(struct v8_open_engine *engine,
					    const unsigned short *words,
					    unsigned count)
{
	unsigned i;

	engine->rx_token_count = 0U;
	engine->remote_call_data = 0U;
	engine->remote_v34 = 0U;
	engine->remote_v32 = 0U;
	engine->remote_lapm = 0U;
	engine->remote_pcm_present = 0U;
	engine->remote_access_present = 0U;
	engine->have_call_match = 0U;
	engine->have_proto_match = 0U;
	engine->matched_call_word = 0U;
	engine->matched_proto_word = 0U;

	for (i = 0U; i < count; ++i) {
		unsigned short word;

		word = (unsigned short)(words[i] & 0x03ffU);

		if (v8_open_word_match_category(word, 0x0101U)) {
			unsigned short call_word;
			unsigned short call_canon;

			call_word = (unsigned short)(word & 0x01ffU);
			engine->remote_call_data = 1U;
			/*
			 * CM words are odd; tolerate a one-bit parity/framing slip
			 * on call/proto words by forcing odd and allowing 1-bit
			 * Hamming distance to canonical data-call encodings.
			 */
			call_canon = (unsigned short)(call_word | 0x0001U);
			if (v8_open_word_hamming10(call_canon, 0x0107U) <= 1U) {
				engine->remote_call_data = 1U;
				engine->have_call_match = 1U;
				engine->matched_call_word = 0x0107U;
				call_word = 0x0107U;
			} else if (v8_open_word_hamming10(call_canon, 0x0109U) <= 1U) {
				engine->remote_call_data = 1U;
				engine->have_call_match = 1U;
				engine->matched_call_word = 0x0109U;
				call_word = 0x0109U;
			} else {
				call_word = (unsigned short)(call_word | 0x0100U);
			}
			v8_open_rx_push_token(engine, call_word);
			continue;
		}

		if (v8_open_word_match_category(word, 0x0141U)) {
			unsigned short mod0;
			unsigned char mod0_octet;

			mod0 = (unsigned short)(word & 0x03ffU);
			mod0 |= 0x0001U;
			mod0_octet = v8_open_decode_word_octet(mod0);
			mod0 = v8_open_encode_octet(mod0_octet);
			engine->remote_v34 = (mod0_octet & 0x40U) ? 1U : 0U;
			engine->remote_pcm_present = (mod0_octet & 0x20U) ? 1U : 0U;
			v8_open_rx_push_token(engine, mod0);

			if ((i + 1U) < count &&
			    v8_open_word_match_mod_ext(words[i + 1U])) {
				unsigned short mod1;
				unsigned char mod1_octet;

				mod1 = (unsigned short)(words[i + 1U] & 0x03ffU);
				mod1 |= 0x0001U;
				mod1_octet = v8_open_decode_word_octet(mod1);
				mod1 = v8_open_encode_octet(mod1_octet);
				engine->remote_v32 = (mod1_octet & 0x01U) ? 1U : 0U;
				v8_open_rx_push_token(engine, mod1);
				i++;
			}
			if ((i + 1U) < count &&
			    v8_open_word_match_mod_ext(words[i + 1U])) {
				unsigned short mod2;
				unsigned char mod2_octet;

				mod2 = (unsigned short)(words[i + 1U] & 0x03ffU);
				mod2 |= 0x0001U;
				mod2_octet = v8_open_decode_word_octet(mod2);
				mod2 = v8_open_encode_octet(mod2_octet);
				v8_open_rx_push_token(engine, mod2);
				i++;
			}
			continue;
		}

		if (v8_open_word_match_category(word, 0x0161U)) {
			unsigned short access_word;
			unsigned char access_octet;

			access_word = (unsigned short)(word & 0x03ffU);
			access_word |= 0x0001U;
			access_octet = v8_open_decode_word_octet(access_word);
			access_word = v8_open_encode_octet(access_octet);
			engine->remote_access_present = 1U;
			v8_open_rx_push_token(engine, access_word);
			continue;
		}

		if (v8_open_word_match_category(word, 0x01c1U)) {
			unsigned short pcm_word;
			unsigned char pcm_octet;

			pcm_word = (unsigned short)(word & 0x03ffU);
			pcm_word |= 0x0001U;
			pcm_octet = v8_open_decode_word_octet(pcm_word);
			pcm_word = v8_open_encode_octet(pcm_octet);
			engine->remote_pcm_present = (pcm_octet & 0xe0U) ? 1U : 0U;
			v8_open_rx_push_token(engine, pcm_word);
			if ((i + 1U) < count &&
			    v8_open_word_match_mod_ext(words[i + 1U])) {
				unsigned short ext_word;
				unsigned char ext_octet;

				ext_word = (unsigned short)(words[i + 1U] & 0x03ffU);
				ext_word |= 0x0001U;
				ext_octet = v8_open_decode_word_octet(ext_word);
				ext_word = v8_open_encode_octet(ext_octet);
				v8_open_rx_push_token(engine, ext_word);
				i++;
			}
			continue;
		}

		if (v8_open_word_match_category(word, 0x00a1U)) {
			unsigned short proto_word;
			unsigned short proto_canon;

			proto_word = (unsigned short)(word & 0x01ffU);
			proto_canon = (unsigned short)(proto_word | 0x0001U);
			if (v8_open_word_hamming10(proto_canon, 0x00a9U) <= 1U) {
				engine->remote_lapm = 1U;
				engine->have_proto_match = 1U;
				engine->matched_proto_word = 0x00a9U;
				proto_word = 0x00a9U;
			}
			v8_open_rx_push_token(engine, proto_word);
			continue;
		}
	}
}

static unsigned v8_open_reframe_words_from_bit_offset(const unsigned short *words,
						       unsigned count,
						       unsigned bit_offset,
						       unsigned short *out_words,
						       unsigned out_cap)
{
	unsigned char bits[V8OPEN_CM_WORDS * 10U];
	unsigned bit_len;
	unsigned out_count;
	unsigned i;
	unsigned b;

	if (!words || !out_words || count == 0U || out_cap == 0U || bit_offset >= 10U)
		return 0U;

	if (count > V8OPEN_CM_WORDS)
		count = V8OPEN_CM_WORDS;

	bit_len = 0U;
	for (i = 0U; i < count; ++i) {
		unsigned short w;

		w = (unsigned short)(words[i] & 0x03ffU);
		for (b = 0U; b < 10U; ++b)
			bits[bit_len++] = (unsigned char)((w >> (9U - b)) & 0x01U);
	}

	if (bit_offset >= bit_len)
		return 0U;

	out_count = (bit_len - bit_offset) / 10U;
	if (out_count > out_cap)
		out_count = out_cap;

	for (i = 0U; i < out_count; ++i) {
		unsigned short w;
		unsigned base;

		w = 0U;
		base = bit_offset + (i * 10U);
		for (b = 0U; b < 10U; ++b)
			w = (unsigned short)((w << 1) | (bits[base + b] & 0x01U));
		out_words[i] = w;
	}

	return out_count;
}

static unsigned v8_open_parse_score(const struct v8_open_engine *engine)
{
	unsigned score;

	score = 0U;
	if (engine->remote_call_data)
		score++;
	if (engine->have_call_match)
		score += 2U;
	if (engine->remote_v34)
		score += 4U;
	if (engine->remote_v32)
		score += 2U;
	if (engine->remote_pcm_present)
		score += 2U;
	if (engine->remote_access_present)
		score++;
	if (engine->have_proto_match)
		score += 2U;
	if (engine->remote_lapm)
		score += 2U;
	score += engine->rx_token_count;
	return score;
}

static void v8_open_parse_rx_sequence(struct v8_open_engine *engine)
{
	unsigned short base[V8OPEN_CM_WORDS];
	unsigned short oriented[V8OPEN_CM_WORDS];
	unsigned short reframed[V8OPEN_CM_WORDS];
	const unsigned short *candidate;
	unsigned candidate_count;
	unsigned count;
	unsigned i;
	unsigned h;
	unsigned off;

	/* Saved state for the best hypothesis found so far. */
	unsigned best_score;
	unsigned best_h;
	unsigned best_off;
	unsigned best_token_count;
	unsigned best_remote_call_data;
	unsigned best_remote_v34;
	unsigned best_remote_v32;
	unsigned best_remote_lapm;
	unsigned best_remote_pcm_present;
	unsigned best_remote_access_present;
	unsigned best_have_call_match;
	unsigned best_have_proto_match;
	unsigned short best_matched_call_word;
	unsigned short best_matched_proto_word;

	count = engine->rx_seq_b_count;
	if (count > V8OPEN_CM_WORDS)
		count = V8OPEN_CM_WORDS;

	for (i = 0U; i < count; ++i)
		base[i] = (unsigned short)(engine->rx_seq_b[i] & 0x03ffU);

	best_score = 0U;
	best_h = 0U;
	best_off = 0U;
	best_token_count = 0U;
	best_remote_call_data = 0U;
	best_remote_v34 = 0U;
	best_remote_v32 = 0U;
	best_remote_lapm = 0U;
	best_remote_pcm_present = 0U;
	best_remote_access_present = 0U;
	best_have_call_match = 0U;
	best_have_proto_match = 0U;
	best_matched_call_word = 0U;
	best_matched_proto_word = 0U;

	for (h = 0U; h < 4U; ++h) {
		for (i = 0U; i < count; ++i) {
			unsigned short w;

			w = base[i];
			if (h & 0x01U)
				w ^= 0x03ffU;
			if (h & 0x02U)
				w = v8_open_reverse_word10(w);
			oriented[i] = (unsigned short)(w & 0x03ffU);
		}

		for (off = 0U; off < 10U; ++off) {
			unsigned cur_score;

			if (off == 0U) {
				candidate = oriented;
				candidate_count = count;
			} else {
				candidate_count =
					v8_open_reframe_words_from_bit_offset(oriented,
								      count,
								      off,
								      reframed,
								      V8OPEN_CM_WORDS);
				candidate = reframed;
			}

				if (candidate_count < 4U)
					continue;

			v8_open_parse_rx_sequence_words(engine, candidate, candidate_count);
			if (!v8_open_cm_sequence_valid(engine))
				continue;

			cur_score = v8_open_parse_score(engine);
			if (cur_score > best_score) {
				best_score = cur_score;
				best_h = h;
				best_off = off;
				best_token_count = engine->rx_token_count;
				best_remote_call_data = engine->remote_call_data;
				best_remote_v34 = engine->remote_v34;
				best_remote_v32 = engine->remote_v32;
				best_remote_lapm = engine->remote_lapm;
				best_remote_pcm_present = engine->remote_pcm_present;
				best_remote_access_present = engine->remote_access_present;
				best_have_call_match = engine->have_call_match;
				best_have_proto_match = engine->have_proto_match;
				best_matched_call_word = engine->matched_call_word;
				best_matched_proto_word = engine->matched_proto_word;
			}
		}
	}

	if (best_score > 0U) {
		/* Restore the best hypothesis result. */
		engine->rx_token_count = best_token_count;
		engine->remote_call_data = best_remote_call_data;
		engine->remote_v34 = best_remote_v34;
		engine->remote_v32 = best_remote_v32;
		engine->remote_lapm = best_remote_lapm;
		engine->remote_pcm_present = best_remote_pcm_present;
		engine->remote_access_present = best_remote_access_present;
		engine->have_call_match = best_have_call_match;
		engine->have_proto_match = best_have_proto_match;
		engine->matched_call_word = best_matched_call_word;
		engine->matched_proto_word = best_matched_proto_word;
		if (best_h != 0U || best_off != 0U) {
			V8OPEN_DBG("cm-stub: parser accepted orientation hypothesis=%u bitoff=%u tokens=%u\n",
				  best_h,
				  best_off,
				  best_token_count);
		}
		return;
	}

	/* Restore default interpretation when no hypothesis validates. */
	v8_open_parse_rx_sequence_words(engine, base, count);
}

static void v8_open_observe_cm(struct v8_open_engine *engine,
			       const void *in,
			       int cnt)
{
	const short *samples;
	unsigned peak_abs;
	unsigned avg_abs;
	unsigned signature;
	unsigned detector_hits;
	unsigned detector_peak;
	unsigned detector_tripped;
	unsigned stage2_before;

	if (!engine || !in || cnt <= 0)
		return;
	if (engine->phase != V8_OPEN_PHASE_ANS_SEND_ANSAM &&
	    engine->phase != V8_OPEN_PHASE_ANS_WAIT_FOR_CM)
		return;
	if (engine->cm_detected)
		return;

	samples = (const short *)in;
	signature = v8_open_capture_signature(samples, cnt, &avg_abs, &peak_abs);

	/* Active CM collector: either decode completes or timeout/rearm. */
	if (engine->cm_collecting) {
		if (!v8_open_rx_consume_samples(engine, samples, cnt)) {
			if (engine->cm_collect_deadline &&
			    engine->samples_in_phase >= engine->cm_collect_deadline) {
				V8OPEN_DBG("cm-stub: collector timeout avg=%u peak=%u bits=%u/%u runs=%u/%u/%u rearming detector\n",
					  avg_abs,
					  peak_abs,
					  engine->rx_dbg_bit0,
					  engine->rx_dbg_bit1,
					  engine->rx_c23e,
					  engine->rx_c240,
					  engine->rx_c242);
				engine->cm_collecting = 0U;
				engine->cm_collect_deadline = 0U;
				engine->cm_collect_index = 0U;
				engine->cm_collect_pass = 0U;
				engine->cm_even_words = 0U;
				engine->rx_demod_profile =
					(unsigned)((engine->rx_demod_profile + 1U) & 0x03U);
				v8_open_cm_advance_phase_scan(engine);
				V8OPEN_DBG("cm-stub: rearm toggling demod profile=%u phase-scan skip=%u\n",
					  engine->rx_demod_profile,
					  engine->rx_lock_skip_bits);
				v8_open_rx_start_search(engine);
				v8_open_answer_predetector_arm(engine);
				engine->cm_predetecting = 1U;
				engine->cm_predetect_deadline = 0U;
			}
			return;
		}

		engine->cm_predetecting = 0U;
		engine->cm_predetect_deadline = 0U;
		engine->cm_collecting = 0U;
		engine->cm_collect_deadline = 0U;
		engine->cm_detected = 1U;
		v8_open_parse_rx_sequence(engine);
		engine->cm_guard_budget = v8_open_samples_from_ms(engine, 40U);
		engine->samples_in_phase = 0U;
		v8_open_rx_reset_collect(engine);
		(void)signature;
		V8OPEN_DBG("cm-stub: detected 2/2 avg=%u peak=%u remote=data:%u v34:%u v32:%u pcm:%u access:%u rxwords=%u\n",
			  avg_abs,
			  peak_abs,
			  engine->remote_call_data,
			  engine->remote_v34,
			  engine->remote_v32,
			  engine->remote_pcm_present,
			  engine->remote_access_present,
			  engine->rx_seq_b_count);
		return;
	}

	if (engine->phase == V8_OPEN_PHASE_ANS_SEND_ANSAM &&
	    engine->rx_phase_scan_index >= V8OPEN_CM_ANSAM_PHASE_SCAN_MAX &&
	    !engine->cm_collecting &&
	    !engine->cm_detected) {
		/* Bound ANSam-side probing; do full CM recovery in WAIT_FOR_CM. */
		engine->cm_predetecting = 0U;
		engine->cm_predetect_deadline = 0U;
		return;
	}

	if (!engine->cm_predetecting) {
		v8_open_answer_predetector_arm(engine);
		engine->cm_seen_count = 0U;
		engine->ans_det_12 = 0U;
		engine->ans_rx_1a = 0U;
		engine->ans_rx_c8 = 0U;
		engine->cm_signature = signature;
		engine->cm_predetecting = 1U;
		engine->cm_predetect_deadline = 0U;
	}

	(void)v8_open_rx_consume_samples(engine, samples, cnt);
	stage2_before = engine->ans_det_06;
	detector_hits = 0U;
	detector_peak = 0U;
	detector_tripped = v8_open_answer_detector_step(engine,
						    samples,
						    cnt,
						    &detector_hits,
						    &detector_peak);
	engine->cm_seen_count += detector_hits;
	engine->ans_rx_1a = (unsigned short)(engine->ans_rx_1a +
				(unsigned short)detector_hits);
	if (detector_peak > engine->ans_rx_c8)
		engine->ans_rx_c8 = (unsigned short)detector_peak;
	if (!detector_hits)
		engine->ans_rx_14 = (unsigned short)(engine->ans_rx_14 + 1U);

	if (!stage2_before && engine->ans_det_06) {
		unsigned stage2_wait;
		unsigned stage2_wait_cap;

		stage2_wait = engine->det_e5c ? engine->det_e5c :
			v8_open_samples_from_ms(engine, V8OPEN_CM_STAGE2_WAIT_MS);
		stage2_wait_cap = v8_open_samples_from_ms(engine,
						V8OPEN_CM_STAGE2_WAIT_CAP_MS);
		if (stage2_wait > stage2_wait_cap)
			stage2_wait = stage2_wait_cap;
		engine->cm_predetect_deadline = engine->samples_in_phase + stage2_wait;
		engine->rx_dbg_bit0 = 0U;
		engine->rx_dbg_bit1 = 0U;
		engine->rx_dbg_low_energy = 0U;
		engine->rx_c23e = 0U;
		engine->rx_c240 = 0U;
		engine->rx_c242 = 0U;
		V8OPEN_DBG("cm-stub: detector stage2 entered run=%u metric=%u\n",
			  engine->ans_det_30,
			  engine->ans_det_12);
	}

	/*
	 * Start CM collection when the energy detector confirms signal.
	 *
	 * The blob uses DFT energy + phase-reversal detection (states 0x19
	 * → 0x2d) before starting V.21 demod — it never requires V.21
	 * diversity as a precondition.  Match that: allow detector_tripped
	 * (sustained energy above threshold) to trigger collection in ANY
	 * answer-side phase, not just ANS_WAIT_FOR_CM.  The diversity gate
	 * (handoff_ready) is kept as a fast path for when demod bits are
	 * already balanced.
	 */
	if (engine->ans_det_06 &&
	    (v8_open_handoff_ready(engine, avg_abs, peak_abs) ||
	     detector_tripped)) {
		engine->cm_predetecting = 0U;
		engine->cm_predetect_deadline = 0U;
		engine->cm_signature = signature;
		v8_open_cm_collect_start(engine, samples, cnt);
		V8OPEN_DBG("cm-stub: detector handoff avg=%u peak=%u hits=%u tripped=%u starting long collector %u/%u\n",
			  avg_abs,
			  peak_abs,
			  engine->cm_seen_count,
			  detector_tripped ? 1U : 0U,
			  engine->rx_seq_b_count,
			  V8OPEN_CM_WORDS);
		return;
	}

	if (engine->ans_det_06) {
		if (!engine->cm_predetect_deadline ||
		    engine->samples_in_phase < engine->cm_predetect_deadline) {
			if ((engine->ans_rx_14 & V8OPEN_CM_STAGE2_WAIT_LOG_MASK) == 0U) {
				unsigned remain;

				remain = 0U;
				if (engine->cm_predetect_deadline > engine->samples_in_phase)
					remain = engine->cm_predetect_deadline - engine->samples_in_phase;
				V8OPEN_DBG("cm-stub: stage2 waiting for diversity avg=%u peak=%u bits=%u/%u runs=%u/%u/%u deadline_in=%u\n",
					  avg_abs,
					  peak_abs,
					  engine->rx_dbg_bit0,
					  engine->rx_dbg_bit1,
					  engine->rx_c23e,
					  engine->rx_c240,
					  engine->rx_c242,
					  remain);
			}
			return;
		}

		/*
		 * Stage2 deadline expired without diversity.  The blob's
		 * equivalent (state 0x2d) transitions straight into V.21
		 * demod based on DFT energy alone — it does not cycle
		 * profiles.  If the detector has accumulated enough hits,
		 * trust the energy evidence and start collection.  Only
		 * rearm and cycle profiles as a last resort.
		 */
		if (engine->cm_seen_count >= 4U) {
			V8OPEN_DBG("cm-stub: stage2 deadline no-diversity but good energy hits=%u avg=%u peak=%u bits=%u/%u, starting collector\n",
				  engine->cm_seen_count,
				  avg_abs,
				  peak_abs,
				  engine->rx_dbg_bit0,
				  engine->rx_dbg_bit1);
			engine->cm_predetecting = 0U;
			engine->cm_predetect_deadline = 0U;
			engine->cm_signature = signature;
			v8_open_cm_collect_start(engine, samples, cnt);
			return;
		}
		V8OPEN_DBG("cm-stub: stage2 deadline no-diversity avg=%u peak=%u bits=%u/%u runs=%u/%u/%u, rearming detector\n",
			  avg_abs,
			  peak_abs,
			  engine->rx_dbg_bit0,
			  engine->rx_dbg_bit1,
			  engine->rx_c23e,
			  engine->rx_c240,
			  engine->rx_c242);
		engine->cm_predetect_deadline = 0U;
		engine->rx_demod_profile =
			(unsigned)((engine->rx_demod_profile + 1U) & 0x03U);
		v8_open_cm_advance_phase_scan(engine);
		V8OPEN_DBG("cm-stub: stage2 rearm toggling demod profile=%u phase-scan skip=%u\n",
			  engine->rx_demod_profile,
			  engine->rx_lock_skip_bits);
		v8_open_rx_start_search(engine);
		v8_open_answer_predetector_arm(engine);
		engine->cm_predetecting = 1U;
		engine->cm_predetect_deadline = 0U;
		return;
	}

	/* Keep CM logs focused on state transitions/handoffs; per-tick
	 * "detector armed" traces are too noisy and do not exist in blob output.
	 */
}

static void v8_open_observe_cj(struct v8_open_engine *engine,
			       const void *in,
			       int cnt)
{
	const short *samples;
	unsigned peak_abs;
	unsigned avg_abs;
	unsigned signature;
	unsigned detector_hits;
	unsigned detector_peak;
	unsigned detector_tripped;

	if (!engine || !in || cnt <= 0)
		return;
	if (engine->phase != V8_OPEN_PHASE_ANS_WAIT_FOR_CJ)
		return;
	if (engine->cj_detected)
		return;

	samples = (const short *)in;
	signature = v8_open_capture_signature(samples, cnt, &avg_abs, &peak_abs);

	/*
	 * CJ exchange is short and sparse; run a continuous collector once we
	 * enter ANS_WAIT_FOR_CJ instead of depending on stage2 detector handoff.
	 */
	if (!engine->cj_collecting) {
		engine->cj_signature = signature;
		engine->cj_seen_count++;
		v8_open_cj_collect_start(engine, samples, cnt);
		V8OPEN_DBG("cj-stub: direct collector armed avg=%u peak=%u attempt=%u prof=%u\n",
			  avg_abs,
			  peak_abs,
			  engine->cj_seen_count,
			  engine->rx_demod_profile);
	}

	if (!v8_open_rx_consume_samples(engine, samples, cnt)) {
		/*
		 * Fast-track CJ acceptance: after preamble lock, the CJ signal
		 * is too short to collect 3 full 10-bit words at the slow demod
		 * rate. If preamble lock found alternating pattern (0x155) or
		 * all-ones (0x3ff) and the shift register contains a CJ-like
		 * value, accept CJ immediately.
		 */
		if (engine->rx_word_sync) {
			unsigned short reg;
			unsigned echo_guard;

			echo_guard = v8_open_samples_from_ms(engine,
					V8OPEN_CJ_ECHO_GUARD_MS);
			reg = (unsigned short)(engine->rx_c23a & 0x03ffU);
			if ((reg & 0x03feU) == 0x03feU ||
			    (reg & 0x03feU) == 0x0000U) {
				if (engine->samples_in_phase < echo_guard) {
					if (engine->samples_in_phase <
					    (engine->cfg.sample_rate / 100U))
						V8OPEN_DBG("cj-stub: fast-track suppressed (echo guard) phase_ms=%u guard_ms=%u avg=%u peak=%u\n",
							  (engine->samples_in_phase * 1000U) /
								  engine->cfg.sample_rate,
							  V8OPEN_CJ_ECHO_GUARD_MS,
							  avg_abs,
							  peak_abs);
					return;
				}
				V8OPEN_DBG("cj-stub: fast-track accept on preamble lock c23a=%03x reg=%03x avg=%u peak=%u phase_ms=%u\n",
					  (unsigned)engine->rx_c23a,
					  (unsigned)reg,
					  avg_abs,
					  peak_abs,
					  (engine->samples_in_phase * 1000U) /
						  engine->cfg.sample_rate);
				goto cj_accept;
			}
		}
		return;
	}

	/* Echo guard: reject CJ accepted too soon after JM TX ended */
	{
		unsigned echo_guard;

		echo_guard = v8_open_samples_from_ms(engine,
				V8OPEN_CJ_ECHO_GUARD_MS);
		if (engine->samples_in_phase < echo_guard) {
			V8OPEN_DBG("cj-stub: normal accept suppressed (echo guard) phase_ms=%u guard_ms=%u avg=%u peak=%u\n",
				  (engine->samples_in_phase * 1000U) /
					  engine->cfg.sample_rate,
				  V8OPEN_CJ_ECHO_GUARD_MS,
				  avg_abs,
				  peak_abs);
			return;
		}
	}

cj_accept:
	engine->cj_predetecting = 0U;
	engine->cj_predetect_deadline = 0U;
	engine->cj_collecting = 0U;
	engine->cj_collect_deadline = 0U;
	engine->cj_detected = 1U;
	engine->cj_guard_budget = v8_open_samples_from_ms(engine, 40U);
	engine->samples_in_phase = 0U;
	v8_open_rx_reset_collect(engine);
	V8OPEN_DBG("cj-stub: detected direct avg=%u peak=%u rxwords=%u variant=%u attempts=%u\n",
		  avg_abs,
		  peak_abs,
		  engine->rx_seq_a_count,
		  engine->cj_variant_bit,
		  engine->cj_seen_count);
	return;

	if (engine->cj_predetecting) {
		unsigned stage2_before;

		stage2_before = engine->ans_det_06;
		detector_hits = 0U;
		detector_peak = 0U;
		detector_tripped = 0U;
		(void)v8_open_rx_consume_samples(engine, samples, cnt);
		detector_tripped = v8_open_answer_detector_step(engine,
							    samples,
							    cnt,
							    &detector_hits,
							    &detector_peak);
		engine->cj_seen_count += detector_hits;
		engine->ans_rx_1a = (unsigned short)(engine->ans_rx_1a +
					(unsigned short)detector_hits);
		if (detector_peak > engine->ans_rx_c8)
			engine->ans_rx_c8 = (unsigned short)detector_peak;
		if (!stage2_before && engine->ans_det_06) {
			engine->cj_predetect_deadline = engine->samples_in_phase +
				(engine->det_e60 ? engine->det_e60 :
				 v8_open_samples_from_ms(engine, 420U));
			V8OPEN_DBG("cj-stub: detector stage2 entered run=%u metric=%u\n",
				  engine->ans_det_30,
				  engine->ans_det_12);
			if (v8_open_handoff_ready(engine, avg_abs, peak_abs)) {
				engine->cj_predetecting = 0U;
				engine->cj_predetect_deadline = 0U;
				engine->cj_signature = signature;
				v8_open_cj_collect_start(engine, samples, cnt);
				V8OPEN_DBG("cj-stub: detector handoff avg=%u peak=%u hits=%u starting short collector %u/%u\n",
					  avg_abs,
					  peak_abs,
					  engine->cj_seen_count,
					  engine->rx_seq_a_count,
					  V8OPEN_CJ_WORDS);
				return;
			}
		}
		if (!detector_hits)
			engine->ans_rx_14 = (unsigned short)(engine->ans_rx_14 + 1U);
		if (!detector_tripped)
			return;

		engine->cj_predetecting = 0U;
		engine->cj_predetect_deadline = 0U;
		engine->cj_signature = signature;
		v8_open_cj_collect_start(engine, samples, cnt);
		V8OPEN_DBG("cj-stub: detector tripped avg=%u peak=%u hits=%u starting short collector %u/%u\n",
			  avg_abs,
			  peak_abs,
			  engine->cj_seen_count,
			  engine->rx_seq_a_count,
			  V8OPEN_CJ_WORDS);
		return;
	}

	if (engine->cj_collecting) {
		if (!v8_open_rx_consume_samples(engine, samples, cnt)) {
			if (engine->cj_collect_deadline &&
			    engine->samples_in_phase >= engine->cj_collect_deadline) {
				V8OPEN_DBG("cj-stub: collector timeout avg=%u peak=%u bits=%u/%u runs=%u/%u/%u rearming detector\n",
					  avg_abs,
					  peak_abs,
					  engine->rx_dbg_bit0,
					  engine->rx_dbg_bit1,
					  engine->rx_c23e,
					  engine->rx_c240,
					  engine->rx_c242);
				engine->cj_collecting = 0U;
				engine->cj_collect_deadline = 0U;
				engine->cj_collect_index = 0U;
				engine->rx_demod_profile =
					(unsigned)((engine->rx_demod_profile + 1U) & 0x03U);
				V8OPEN_DBG("cj-stub: rearm toggling demod profile=%u\n",
					  engine->rx_demod_profile);
				v8_open_rx_start_search(engine);
				v8_open_answer_predetector_arm(engine);
				engine->cj_predetecting = 1U;
				engine->cj_predetect_deadline = 0U;
			}
			return;
		}

		/* Echo guard: reject if accepted too soon after JM TX */
		{
			unsigned echo_guard2;

			echo_guard2 = v8_open_samples_from_ms(engine,
					V8OPEN_CJ_ECHO_GUARD_MS);
			if (engine->samples_in_phase < echo_guard2) {
				V8OPEN_DBG("cj-stub: 2/2 accept suppressed (echo guard) phase_ms=%u guard_ms=%u avg=%u peak=%u\n",
					  (engine->samples_in_phase * 1000U) /
						  engine->cfg.sample_rate,
					  V8OPEN_CJ_ECHO_GUARD_MS,
					  avg_abs,
					  peak_abs);
				return;
			}
		}
		engine->cj_predetecting = 0U;
		engine->cj_predetect_deadline = 0U;
		engine->cj_collecting = 0U;
		engine->cj_collect_deadline = 0U;
		engine->cj_detected = 1U;
		engine->cj_guard_budget = v8_open_samples_from_ms(engine, 40U);
		engine->samples_in_phase = 0U;
		v8_open_rx_reset_collect(engine);
		(void)signature;
		V8OPEN_DBG("cj-stub: detected 2/2 avg=%u peak=%u rxwords=%u variant=%u\n",
			  avg_abs,
			  peak_abs,
			  engine->rx_seq_a_count,
			  engine->cj_variant_bit);
		return;
	}
	v8_open_answer_predetector_arm(engine);
	engine->cj_seen_count = 0U;
	engine->ans_det_12 = 0U;
	engine->ans_rx_1a = 0U;
	engine->ans_rx_c8 = 0U;
	engine->cj_signature = signature;
	engine->cj_predetecting = 1U;
	engine->cj_predetect_deadline = 0U;
	(void)v8_open_rx_consume_samples(engine, samples, cnt);
	{
		unsigned stage2_before;

		stage2_before = engine->ans_det_06;
	detector_hits = 0U;
	detector_peak = 0U;
	detector_tripped = v8_open_answer_detector_step(engine,
						    samples,
						    cnt,
						    &detector_hits,
						    &detector_peak);
	engine->cj_seen_count += detector_hits;
	engine->ans_rx_1a = (unsigned short)(engine->ans_rx_1a +
				(unsigned short)detector_hits);
	if (detector_peak > engine->ans_rx_c8)
		engine->ans_rx_c8 = (unsigned short)detector_peak;
	if (!stage2_before && engine->ans_det_06) {
		engine->cj_predetect_deadline = engine->samples_in_phase +
			(engine->det_e60 ? engine->det_e60 :
			 v8_open_samples_from_ms(engine, 420U));
		V8OPEN_DBG("cj-stub: detector stage2 entered run=%u metric=%u\n",
			  engine->ans_det_30,
			  engine->ans_det_12);
		if (v8_open_handoff_ready(engine, avg_abs, peak_abs)) {
			engine->cj_predetecting = 0U;
			engine->cj_predetect_deadline = 0U;
			engine->cj_signature = signature;
			v8_open_cj_collect_start(engine, samples, cnt);
			V8OPEN_DBG("cj-stub: detector handoff avg=%u peak=%u hits=%u starting short collector %u/%u\n",
				  avg_abs,
				  peak_abs,
				  engine->cj_seen_count,
				  engine->rx_seq_a_count,
				  V8OPEN_CJ_WORDS);
			return;
		}
	}
	if (!detector_hits)
		engine->ans_rx_14 = (unsigned short)(engine->ans_rx_14 + 1U);
	}
	if (detector_tripped) {
		engine->cj_predetecting = 0U;
		engine->cj_predetect_deadline = 0U;
		v8_open_cj_collect_start(engine, samples, cnt);
		V8OPEN_DBG("cj-stub: detector tripped avg=%u peak=%u hits=%u starting short collector %u/%u\n",
			  avg_abs,
			  peak_abs,
			  engine->cj_seen_count,
			  engine->rx_seq_a_count,
			  V8OPEN_CJ_WORDS);
		return;
	}
	V8OPEN_DBG("cj-stub: detector armed avg=%u peak=%u hold=%u hits=%u thresh=%u window=%u\n",
		  avg_abs,
		  peak_abs,
		  v8_open_samples_from_ms(engine, v8_open_answer_detector_window(engine)),
		  engine->cj_seen_count,
		  engine->ans_det_0a,
		  v8_open_answer_detector_window(engine));
}

static unsigned v8_open_phase_status(const struct v8_open_engine *engine,
				     enum v8_open_phase phase)
{
	(void)engine;

	switch (phase) {
	case V8_OPEN_PHASE_BOOT:
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CI:
		return V8_OPEN_STATUS_INIT;
	case V8_OPEN_PHASE_ANS_SEND_ANSAM:
		return V8_OPEN_STATUS_ANS_SEND_ANSAM;
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CM:
		return V8_OPEN_STATUS_ANS_SEND_ANSAM;
	case V8_OPEN_PHASE_ANS_SEND_JM:
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CJ:
		return V8_OPEN_STATUS_ANS_SEND_JM;
	case V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM:
		if (engine->ans_cm_timeout_fallback)
			return V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CM;
		if (engine->ans_cj_timeout_fallback)
			return V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CJ;
		return V8_OPEN_STATUS_ANS_SEND_JM;
	case V8_OPEN_PHASE_ORG_SEND_CM:
		return V8_OPEN_STATUS_ORG_SEND_CM;
	case V8_OPEN_PHASE_ORG_WAIT_FOR_ANSAM:
		return V8_OPEN_STATUS_ORG_SEND_CM;
	case V8_OPEN_PHASE_ORG_WAIT_FOR_JM:
		return V8_OPEN_STATUS_ORG_JM_DETECTED;
	case V8_OPEN_PHASE_COMPLETE:
	default:
		if (!engine->cfg.answer_mode &&
		    engine->quick_connect_enabled &&
		    ((enum DP_ID)engine->cfg.target_dp_id == DP_V90 ||
		     (enum DP_ID)engine->cfg.target_dp_id == DP_V92))
			return V8_OPEN_STATUS_ORG_WAITING_FOR_QCA1D;
		return V8_OPEN_STATUS_OK;
	}
}

static enum DP_ID v8_open_preferred_dp(const struct v8_open_engine *engine)
{
	/*
	 * When CM was detected but capability tokens are weak/ambiguous,
	 * prefer conservative non-PCM fallback instead of jumping back to the
	 * target DP and forcing V.34 training on bad evidence.
	 */
	if (engine->cm_detected) {
		if (engine->cfg.advertise.v92 &&
		    engine->cfg.advertise.access_digital &&
		    engine->cfg.advertise.pcm_digital &&
		    engine->remote_pcm_present)
			return DP_V92;
		if (engine->cfg.advertise.v90 &&
		    engine->cfg.advertise.access_digital &&
		    engine->cfg.advertise.pcm_digital &&
		    engine->remote_pcm_present)
			return DP_V90;
		if (engine->cfg.advertise.v34 &&
		    engine->remote_v34)
			return DP_V34;
		if (engine->cfg.advertise.v32)
			return DP_V32;
		if (engine->cfg.advertise.v22)
			return DP_V22;
		return (enum DP_ID)engine->cfg.target_dp_id;
	}

	if (engine->cfg.advertise.v92 &&
	    engine->cfg.advertise.access_digital &&
	    engine->cfg.advertise.pcm_digital &&
	    engine->remote_pcm_present)
		return DP_V92;
	if (engine->cfg.advertise.v90 &&
	    engine->cfg.advertise.access_digital &&
	    engine->cfg.advertise.pcm_digital &&
	    engine->remote_pcm_present)
		return DP_V90;
	if (engine->cfg.advertise.v34 &&
	    engine->remote_v34)
		return DP_V34;
	if (engine->cfg.advertise.v32 &&
	    engine->remote_v32)
		return DP_V32;
	if (engine->cfg.advertise.v34)
		return DP_V34;
	if (engine->cfg.advertise.v32)
		return DP_V32;
	if (engine->cfg.advertise.v22)
		return DP_V22;
	return (enum DP_ID)engine->cfg.target_dp_id;
}

static void v8_open_prepare_jm_shim(struct v8_open_engine *engine)
{
	struct v8_open_jm_shim *jm;
	char mod1_desc[24];
	char mod2_desc[24];
	char pcm_desc[24];
	char tail_desc[24];
	unsigned char local_mod0_octet;
	unsigned char local_mod1_octet;
	unsigned char local_mod2_octet;
	unsigned char local_pcm_octet;
	unsigned short rx_call;
	unsigned short rx_mod0;
	unsigned short rx_mod1;
	unsigned short rx_mod2;
	unsigned short rx_access;
	unsigned short rx_pcm;
	unsigned short rx_proto;
	unsigned want_pcm;
	unsigned want_access;
	unsigned short local_pcm_word;
	jm = &engine->jm;
	memset(jm, 0, sizeof(*jm));

	jm->data_supported = engine->cfg.advertise.data && engine->remote_call_data;
	jm->lapm_supported = engine->cfg.advertise.lapm && engine->remote_lapm;
	jm->quick_connect_supported = engine->cfg.advertise.quick_connect;
	jm->preferred_dp = v8_open_preferred_dp(engine);
	engine->preferred_dp = jm->preferred_dp;
	jm->access_tag = 0x0161;
	jm->access_octet = v8_open_decode_word_octet(jm->access_tag);
	jm->access_call_cellular = engine->cfg.advertise.access_call_cellular;
	jm->access_answer_cellular = engine->cfg.advertise.access_answer_cellular;
	jm->access_digital = engine->cfg.advertise.access_digital;
	jm->pcm_analog = engine->cfg.advertise.pcm_analog && engine->remote_pcm_present;
	jm->pcm_digital = engine->cfg.advertise.pcm_digital && engine->remote_pcm_present;
	jm->pcm_v91 = engine->cfg.advertise.pcm_v91 && engine->remote_pcm_present;

	local_mod0_octet = 0x05U;
	local_mod1_octet = 0x10U;
	local_mod2_octet = 0x10U;
	local_pcm_octet = 0x07U;

	if (engine->cfg.advertise.v92 && engine->cfg.advertise.access_digital &&
	    engine->cfg.advertise.pcm_digital && engine->remote_pcm_present)
		jm->modulation_mask |= 0x10U;
	if (engine->cfg.advertise.v90 && engine->cfg.advertise.access_digital &&
	    engine->cfg.advertise.pcm_digital && engine->remote_pcm_present)
		jm->modulation_mask |= 0x08U;
	if (engine->cfg.advertise.v34 &&
	    engine->remote_v34) {
		jm->modulation_mask |= 0x04U;
		local_mod0_octet |= 0x40U;
	}
	if (engine->cfg.advertise.v32 && engine->remote_v32) {
		jm->modulation_mask |= 0x02U;
		local_mod1_octet |= 0x01U;
	}
	if (engine->cfg.advertise.v22) {
		jm->modulation_mask |= 0x01U;
		local_mod1_octet |= 0x02U;
	}

	if (jm->pcm_analog || jm->pcm_digital || jm->pcm_v91) {
		local_mod0_octet |= 0x20U;
		if (jm->pcm_analog)
			local_pcm_octet |= 0x20U;
		if (jm->pcm_digital)
			local_pcm_octet |= 0x40U;
		if (jm->pcm_v91)
			local_pcm_octet |= 0x80U;
	}

	jm->modulation0_octet = local_mod0_octet;
	jm->modulation1_octet = local_mod1_octet;
	jm->modulation2_octet = local_mod2_octet;
	jm->pcm_octet = local_pcm_octet;
	local_pcm_word = v8_open_encode_octet(local_pcm_octet);

	rx_call = v8_open_find_rx_token(engine, 0x0101U, 0U);
	rx_mod0 = v8_open_find_rx_token(engine, 0x0141U, 0U);
	rx_mod1 = v8_open_find_rx_token(engine, 0x0141U, 1U);
	rx_mod2 = v8_open_find_rx_token(engine, 0x0141U, 2U);
	rx_access = v8_open_find_rx_token(engine, 0x0161U, 0U);
	rx_pcm = v8_open_find_rx_token(engine, 0x01c1U, 0U);
	rx_proto = v8_open_find_rx_token(engine, 0x00a1U, 0U);

	engine->have_call_match = 0U;
	engine->have_proto_match = 0U;
	engine->matched_call_word = 0U;
	engine->matched_proto_word = 0U;

	if (jm->data_supported &&
	    (rx_call == 0x0107U || rx_call == 0x0109U)) {
		jm->call_function_code = 0x0107U;
		engine->have_call_match = 1U;
		engine->matched_call_word = 0x0107U;
	} else if (jm->data_supported) {
		/*
		 * Proprietary caller expects DATA call-function (0x0107) for
		 * call-function match; 0x0109 fallback leads to mismatch and
		 * suppresses remote modulation capability reporting.
		 */
		jm->call_function_code = 0x0107U;
	} else {
		jm->call_function_code = 0x0000U;
	}

	jm->modulation0_octet = local_mod0_octet;
	if (rx_mod0) {
		unsigned char rx_mod0_octet;

		rx_mod0_octet = v8_open_decode_word_octet((unsigned short)(rx_mod0 | 0x0001U));
		jm->modulation0_octet =
			(unsigned char)((jm->modulation0_octet & rx_mod0_octet) | 0x05U);
	}
	jm->modulation0_word = v8_open_encode_octet(jm->modulation0_octet);

	jm->has_modulation1 = 1U;
	jm->modulation1_octet = local_mod1_octet;
	if (rx_mod1) {
		unsigned char rx_mod1_octet;

		rx_mod1_octet = v8_open_decode_word_octet((unsigned short)(rx_mod1 | 0x0001U));
		jm->modulation1_octet =
			(unsigned char)((jm->modulation1_octet & rx_mod1_octet) | 0x10U);
	}
	jm->modulation1_word = v8_open_encode_octet(jm->modulation1_octet);

	jm->modulation2_octet = local_mod2_octet;
	if (rx_mod2) {
		unsigned char rx_mod2_octet;

		rx_mod2_octet = v8_open_decode_word_octet((unsigned short)(rx_mod2 | 0x0001U));
		jm->modulation2_octet =
			(unsigned char)((jm->modulation2_octet & rx_mod2_octet) | 0x10U);
	}
	jm->modulation2_word = v8_open_encode_octet(jm->modulation2_octet);

	want_pcm = (rx_pcm != 0U) && (jm->pcm_analog || jm->pcm_digital || jm->pcm_v91);
	if (want_pcm) {
		jm->has_pcm = 1U;
		jm->pcm_word = local_pcm_word;
		jm->access_word = 0x0011U;
	}

	want_access =
		jm->has_pcm ||
		(rx_access != 0U) ||
		engine->cfg.advertise.access_call_cellular ||
		engine->cfg.advertise.access_answer_cellular ||
		engine->cfg.advertise.access_digital;
	if (!want_access)
		jm->access_tag = 0U;

	if (jm->lapm_supported && rx_proto == 0x00a9U) {
		jm->protocol_code = rx_proto;
		engine->have_proto_match = 1U;
		engine->matched_proto_word = rx_proto;
	} else if (jm->lapm_supported) {
		jm->protocol_code = 0x00a9U;
	} else {
		jm->protocol_code = 0x0000U;
	}

	v8_open_jm_push(jm, 0x03ffU, 0);
	v8_open_jm_push(jm, 0x000fU, 0);
	if (jm->call_function_code)
		v8_open_jm_push(jm, jm->call_function_code, 1);
	v8_open_jm_push(jm, jm->modulation0_word, 1);
	v8_open_jm_push(jm, jm->modulation1_word, 1);
	v8_open_jm_push(jm, jm->modulation2_word, 1);
	if (jm->access_tag) {
		v8_open_jm_push(jm, jm->access_tag, 1);
		if (jm->has_pcm) {
			v8_open_jm_push(jm, jm->pcm_word, 1);
			v8_open_jm_push(jm, jm->access_word, 1);
		}
	}
	if (jm->protocol_code)
		v8_open_jm_push(jm, jm->protocol_code, 1);

	jm->octet_count = jm->word_count >= 2U ? jm->word_count - 2U : 0U;
	jm->prepared = 1U;
	v8_open_prepare_jm_bits(engine);

	if (jm->has_modulation1)
		snprintf(mod1_desc, sizeof(mod1_desc), "%03x(%02x)",
			 jm->modulation1_word, jm->modulation1_octet);
	else
		snprintf(mod1_desc, sizeof(mod1_desc), "none");

	snprintf(mod2_desc, sizeof(mod2_desc), "%03x(%02x)",
		 jm->modulation2_word, jm->modulation2_octet);

	if (jm->has_pcm)
		snprintf(pcm_desc, sizeof(pcm_desc), "%03x(%02x)",
			 jm->pcm_word, jm->pcm_octet);
	else
		snprintf(pcm_desc, sizeof(pcm_desc), "none");

	if (jm->has_pcm)
		snprintf(tail_desc, sizeof(tail_desc), "%03x(%02x)",
			 jm->access_word,
			 jm->access_word ? v8_open_decode_word_octet(jm->access_word) : 0U);
	else
		snprintf(tail_desc, sizeof(tail_desc), "none");

	V8OPEN_DBG("jm-shim: octets=%u words=%u data=%u preferred=%s mask=%02x mod0:%03x(%02x) mod1:%s mod2:%s access:%03x(%02x) call:%03x(%02x) proto:%03x(%02x) pcm:%s pcmx:%s access_bits=call:%u ans:%u dig:%u pcm_bits=a:%u d:%u v91:%u qc=%u lapm=%u\n",
		  jm->octet_count,
		  jm->word_count,
		  jm->data_supported,
		  v8_open_dp_name(jm->preferred_dp),
		  jm->modulation_mask,
		  jm->modulation0_word,
		  jm->modulation0_octet,
		  mod1_desc,
		  mod2_desc,
		  jm->access_tag,
		  v8_open_decode_word_octet(jm->access_tag),
		  jm->call_function_code,
		  jm->call_function_code ? v8_open_decode_word_octet(jm->call_function_code) : 0U,
		  jm->protocol_code,
		  jm->protocol_code ? v8_open_decode_word_octet(jm->protocol_code) : 0U,
		  pcm_desc,
		  tail_desc,
		  jm->access_call_cellular,
		  jm->access_answer_cellular,
		  jm->access_digital,
		  jm->pcm_analog,
		  jm->pcm_digital,
		  jm->pcm_v91,
		  jm->quick_connect_supported,
		  jm->lapm_supported);
	v8_open_log_jm_sequence(jm);
}

static enum v8_open_phase v8_open_next_phase(const struct v8_open_engine *engine,
					     enum v8_open_phase phase)
{
	switch (phase) {
	case V8_OPEN_PHASE_BOOT:
		return engine->cfg.answer_mode ?
			V8_OPEN_PHASE_ANS_WAIT_FOR_CI :
			V8_OPEN_PHASE_ORG_SEND_CM;
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CI:
		return V8_OPEN_PHASE_ANS_SEND_ANSAM;
	case V8_OPEN_PHASE_ANS_SEND_ANSAM:
		return V8_OPEN_PHASE_ANS_WAIT_FOR_CM;
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CM:
		return V8_OPEN_PHASE_ANS_SEND_JM;
	case V8_OPEN_PHASE_ANS_SEND_JM:
		return V8_OPEN_PHASE_ANS_WAIT_FOR_CJ;
	case V8_OPEN_PHASE_ANS_WAIT_FOR_CJ:
		return V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM;
	case V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM:
		return V8_OPEN_PHASE_COMPLETE;
	case V8_OPEN_PHASE_ORG_SEND_CM:
		return V8_OPEN_PHASE_ORG_WAIT_FOR_ANSAM;
	case V8_OPEN_PHASE_ORG_WAIT_FOR_ANSAM:
		return V8_OPEN_PHASE_ORG_WAIT_FOR_JM;
	case V8_OPEN_PHASE_ORG_WAIT_FOR_JM:
		return V8_OPEN_PHASE_COMPLETE;
	case V8_OPEN_PHASE_COMPLETE:
	default:
		return V8_OPEN_PHASE_COMPLETE;
	}
}

static void v8_open_transition(struct v8_open_engine *engine,
			       enum v8_open_phase next_phase)
{
	enum v8_open_phase old_phase;

	if (next_phase == V8_OPEN_PHASE_ANS_SEND_ANSAM &&
	    engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CI &&
	    !engine->ci_detected) {
		V8OPEN_DBG("ci-detect: timeout, proceeding to ANSam without CI detection\n");
	}
	if (next_phase == V8_OPEN_PHASE_ANS_SEND_ANSAM &&
	    engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CI) {
		engine->cm_confirm_valid_count = 0U;
		engine->cm_confirm_word_count = 0U;
		memset(engine->cm_confirm_seq, 0, sizeof(engine->cm_confirm_seq));
	}

	if (next_phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CM && engine->cm_detected)
		next_phase = V8_OPEN_PHASE_ANS_SEND_JM;

	if (next_phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CM && !engine->cm_detected) {
		unsigned carry_active;

		carry_active = engine->cm_collecting ||
			(engine->cm_predetecting && engine->cm_seen_count > 0U);
		/* Keep CM detector/collector context continuous across phase edge. */
		if (carry_active) {
			unsigned pred_remain;
			unsigned coll_remain;

			pred_remain = 0U;
			if (engine->cm_predetect_deadline > engine->samples_in_phase)
				pred_remain = engine->cm_predetect_deadline - engine->samples_in_phase;
			else if (engine->cm_predetect_deadline)
				pred_remain = 1U;

			coll_remain = 0U;
			if (engine->cm_collect_deadline > engine->samples_in_phase)
				coll_remain = engine->cm_collect_deadline - engine->samples_in_phase;
			else if (engine->cm_collect_deadline)
				coll_remain = 1U;

			engine->cm_predetect_deadline = pred_remain;
			engine->cm_collect_deadline = coll_remain;
			V8OPEN_DBG("cm-stub: entering WAIT_FOR_CM, carrying active state hits=%u pred=%u collect=%u remain_pred=%u remain_collect=%u runs=%u/%u/%u bits=%u/%u prof=%u\n",
				  engine->cm_seen_count,
				  engine->cm_predetecting,
				  engine->cm_collecting,
				  pred_remain,
				  coll_remain,
				  engine->rx_c23e,
				  engine->rx_c240,
				  engine->rx_c242,
				  engine->rx_dbg_bit0,
				  engine->rx_dbg_bit1,
				  engine->rx_demod_profile);
		}
		if (!carry_active) {
			/*
			 * No in-flight collector to carry: arm detector, but do not
			 * clear demod/orientation history on phase edge.
			 */
			if (!engine->cm_predetecting && !engine->cm_collecting) {
				v8_open_answer_predetector_arm(engine);
				engine->cm_predetecting = 1U;
				engine->cm_predetect_deadline = 0U;
			}
		}
	}

		if (next_phase == V8_OPEN_PHASE_ANS_SEND_JM &&
		    !engine->cm_detected) {
			unsigned short raw12;
			unsigned runs0;
			unsigned runs1;
			unsigned runs2;
			unsigned mark_run;
			unsigned delim_run;
			unsigned word_sync;
			unsigned bits_to_word;
			unsigned emits;
			unsigned hist_fill;
			unsigned phase_off;
			unsigned agc_gain;
			unsigned agc_env;
			unsigned agc_metric;
			unsigned agc_level;
			unsigned sym0;
			unsigned sym1;
			unsigned tick0;
			unsigned tick1;
			unsigned sat_count;
			unsigned low_energy;
			unsigned bit0_count;
			unsigned bit1_count;

			raw12 = (unsigned short)(engine->rx_c23a & 0x0fffU);
			runs0 = engine->rx_c23e;
			runs1 = engine->rx_c240;
			runs2 = engine->rx_c242;
			mark_run = engine->rx_c244;
			delim_run = engine->rx_c246;
			word_sync = engine->rx_word_sync;
			bits_to_word = engine->rx_bits_to_word;
			emits = engine->rx_emit_total;
			hist_fill = engine->rx_demod_hist_fill;
			phase_off = engine->rx_phase_offset;
			agc_gain = engine->rx_agc_gain_q15;
			agc_env = engine->rx_agc_env;
			agc_metric = engine->rx_agc_metric;
			agc_level = engine->rx_agc_level;
			sym0 = engine->rx_c230;
			sym1 = engine->rx_c232;
			tick0 = engine->rx_space_ticks;
			tick1 = engine->rx_mark_ticks;
			sat_count = engine->ans_rx_ac;
			low_energy = engine->rx_dbg_low_energy;
			bit0_count = engine->rx_dbg_bit0;
			bit1_count = engine->rx_dbg_bit1;
			engine->cm_predetecting = 0U;
			engine->cm_predetect_deadline = 0U;
			engine->cm_collecting = 0U;
			engine->cm_collect_deadline = 0U;
			engine->cm_collect_pass = 0U;
			engine->cm_even_words = 0U;
			engine->cm_guard_budget = 0U;
			engine->cm_detected = 0U;
			v8_open_rx_reset_collect(engine);
			V8OPEN_DBG("cm-stub: timeout fallback after %u candidate(s); no valid CM, entering legacy fallback (raw=%03x runs=%u/%u/%u mark=%u delim=%u sync=%u bits=%u emits=%u hist=%u phase=%u agc=%u env=%u metric=%u level=%u sym=%u/%u ticks=%u/%u sat=%u demod=%u/%u/%u prof=%u)\n",
				  engine->cm_seen_count,
				  raw12,
				  runs0,
				  runs1,
				  runs2,
				  mark_run,
				  delim_run,
				  word_sync,
				  bits_to_word,
				  emits,
				  hist_fill,
				  phase_off,
				  agc_gain,
				  agc_env,
				  agc_metric,
				  agc_level,
				  sym0,
				  sym1,
				  tick0,
				  tick1,
				  sat_count,
				  low_energy,
				  bit0_count,
				  bit1_count,
				  engine->rx_demod_profile);
			engine->ans_cm_timeout_fallback = 1U;
			next_phase = V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM;
		} else if (next_phase == V8_OPEN_PHASE_ANS_SEND_JM) {
			engine->ans_cm_timeout_fallback = 0U;
		}
		if (next_phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CJ)
			engine->ans_cj_timeout_fallback = 0U;
	if (next_phase == V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM &&
	    !engine->cj_detected &&
	    (engine->cj_seen_count > 0U || engine->cj_predetecting || engine->cj_collecting)) {
		unsigned short raw12;
		unsigned runs0;
		unsigned runs1;
		unsigned runs2;
		unsigned mark_run;
		unsigned delim_run;
		unsigned word_sync;
		unsigned bits_to_word;
		unsigned emits;
		unsigned hist_fill;
		unsigned phase_off;
		unsigned agc_gain;
		unsigned agc_env;
		unsigned agc_metric;
		unsigned agc_level;
		unsigned sym0;
		unsigned sym1;
		unsigned tick0;
		unsigned tick1;
		unsigned sat_count;
		unsigned low_energy;
		unsigned bit0_count;
		unsigned bit1_count;

		raw12 = (unsigned short)(engine->rx_c23a & 0x0fffU);
		runs0 = engine->rx_c23e;
		runs1 = engine->rx_c240;
		runs2 = engine->rx_c242;
		mark_run = engine->rx_c244;
		delim_run = engine->rx_c246;
		word_sync = engine->rx_word_sync;
		bits_to_word = engine->rx_bits_to_word;
		emits = engine->rx_emit_total;
		hist_fill = engine->rx_demod_hist_fill;
		phase_off = engine->rx_phase_offset;
		agc_gain = engine->rx_agc_gain_q15;
		agc_env = engine->rx_agc_env;
		agc_metric = engine->rx_agc_metric;
		agc_level = engine->rx_agc_level;
		sym0 = engine->rx_c230;
		sym1 = engine->rx_c232;
		tick0 = engine->rx_space_ticks;
		tick1 = engine->rx_mark_ticks;
		sat_count = engine->ans_rx_ac;
		low_energy = engine->rx_dbg_low_energy;
		bit0_count = engine->rx_dbg_bit0;
		bit1_count = engine->rx_dbg_bit1;
		engine->cj_detected = 1U;
		engine->cj_predetecting = 0U;
		engine->cj_predetect_deadline = 0U;
		engine->cj_collecting = 0U;
		engine->cj_collect_deadline = 0U;
		engine->cj_guard_budget = 0U;
		engine->ans_cj_timeout_fallback = 1U;
		v8_open_rx_reset_collect(engine);
		v8_open_collect_remote_cj_defaults(engine);
		V8OPEN_DBG("cj-stub: timeout fallback after %u candidate(s); using conservative remote CJ model (raw=%03x runs=%u/%u/%u mark=%u delim=%u sync=%u bits=%u emits=%u hist=%u phase=%u agc=%u env=%u metric=%u level=%u sym=%u/%u ticks=%u/%u sat=%u demod=%u/%u/%u prof=%u)\n",
			  engine->cj_seen_count,
			  raw12,
			  runs0,
			  runs1,
			  runs2,
			  mark_run,
			  delim_run,
			  word_sync,
			  bits_to_word,
			  emits,
			  hist_fill,
			  phase_off,
			  agc_gain,
			  agc_env,
			  agc_metric,
			  agc_level,
			  sym0,
			  sym1,
			  tick0,
			  tick1,
			  sat_count,
			  low_energy,
			  bit0_count,
			  bit1_count,
			  engine->rx_demod_profile);
	}
	if (next_phase == V8_OPEN_PHASE_ANS_POST_CJ_CONFIRM &&
	    engine->cj_detected &&
	    !engine->ans_cm_timeout_fallback &&
	    !engine->ans_cj_timeout_fallback) {
		engine->ans_cj_timeout_fallback = 0U;
	}

	old_phase = engine->phase;
	engine->phase = next_phase;
	engine->samples_in_phase = 0U;
	engine->last_status = v8_open_phase_status(engine, next_phase);
	v8_open_reset_tx(engine);
	if (next_phase == V8_OPEN_PHASE_ANS_SEND_JM)
		v8_open_prepare_jm_shim(engine);
	V8OPEN_DBG("phase %s -> %s, status=%s, total_samples=%u\n",
		  v8_open_phase_name(old_phase),
		  v8_open_phase_name(next_phase),
		  v8_open_status_name(engine->last_status),
		  engine->total_samples);
}

static void v8_open_capture_runtime(struct v8_open_engine *engine)
{
	const struct v8_open_runtime_prefix *runtime;

	engine->quick_connect_enabled = engine->cfg.advertise.quick_connect;
	engine->lapm_requested = engine->cfg.advertise.lapm;

	runtime = (const struct v8_open_runtime_prefix *)engine->cfg.dp_runtime;
	if (!runtime)
		return;

	engine->initial_flags0 = runtime->flags0;
	engine->initial_flags1 = runtime->flags1;
	engine->initial_flags2 = runtime->flags2;
	engine->initial_qc_index = runtime->qc_index;
}

void *v8_open_create(const struct v8_open_create_cfg *cfg)
{
	struct v8_open_engine *engine;

	engine = calloc(1, sizeof(*engine));
	if (!engine)
		return NULL;

	engine->cfg = *cfg;
	engine->phase = V8_OPEN_PHASE_BOOT;
	engine->samples_in_phase = 0U;
	engine->total_samples = 0U;
	engine->last_status = V8_OPEN_STATUS_INIT;
	engine->tone_phase_q16 = 0U;
	engine->ansam_mod_phase_q16 = 0U;
	engine->ansam_phase_samples = 0U;
	engine->ansam_phase_invert = 0U;
	engine->tx_bit_pos = 0U;
	engine->tx_bit_samples = 0U;
	engine->tx_bit_len = 0U;
	engine->remote_call_data = 0U;
	engine->remote_v34 = 0U;
	engine->remote_v32 = 0U;
	engine->remote_lapm = 0U;
	engine->remote_access_present = 0U;
	engine->remote_pcm_present = 0U;
	engine->cm_seen_count = 0U;
	engine->cm_signature = 0U;
	engine->cm_detected = 0U;
	engine->cm_guard_budget = 0U;
	engine->cm_predetecting = 0U;
	engine->det_e5c = (cfg->signal_detect_timeout_secs *
			   (cfg->sample_rate ? cfg->sample_rate : 9600U)) >> 2;
	engine->det_e60 = (cfg->message_detect_timeout_secs *
			   (cfg->sample_rate ? cfg->sample_rate : 9600U)) >> 2;
	engine->cm_predetect_deadline = 0U;
	engine->cm_collecting = 0U;
	engine->cm_collect_deadline = 0U;
	engine->cm_collect_index = 0U;
	engine->cm_collect_pass = 0U;
	engine->cm_even_words = 0U;
	engine->cm_force_suppress_count = 0U;
	engine->cm_best_pass = 0U;
	engine->cm_best_count = 0U;
	memset(engine->cm_best_seq, 0, sizeof(engine->cm_best_seq));
	engine->cm_confirm_valid_count = 0U;
	engine->cm_confirm_word_count = 0U;
	memset(engine->cm_confirm_seq, 0, sizeof(engine->cm_confirm_seq));
	engine->have_call_match = 0U;
	engine->have_proto_match = 0U;
	engine->matched_call_word = 0U;
	engine->matched_proto_word = 0U;
	engine->rx_seq_a_count = 0U;
	engine->rx_seq_b_count = 0U;
	engine->rx_token_count = 0U;
	engine->cj_seen_count = 0U;
	engine->cj_signature = 0U;
	engine->cj_detected = 0U;
	engine->cj_guard_budget = 0U;
	engine->cj_predetecting = 0U;
	engine->cj_predetect_deadline = 0U;
	engine->cj_collecting = 0U;
	engine->cj_collect_deadline = 0U;
	engine->cj_collect_index = 0U;
	engine->cj_sequence_valid = 0U;
	engine->cj_variant_bit = 0U;
	engine->rx_process_state = 0U;
	engine->rx_demod_profile = 0U;
	engine->rx_phase_scan_index = 0U;
	engine->rx_lock_skip_bits = 0U;
	engine->rx_orient_flip = 0U;
	engine->ans_cm_timeout_fallback = 0U;
	engine->ans_cj_timeout_fallback = 0U;
	engine->cm_framing_stalls = 0U;
	engine->ci_detected = 0U;
	engine->ci_energy_counter = 0U;
	engine->tx_filt_state = 0;
	engine->preferred_dp = (enum DP_ID)cfg->target_dp_id;
	v8_open_rx_reset_collect(engine);
	if (cfg->answer_mode)
		v8_open_answer_predetector_seed(engine);
	v8_open_capture_runtime(engine);
	V8OPEN_DBG("create: side=%s target=%u srate=%u caps=data:%u v92:%u v90:%u v34:%u v32:%u v22:%u qc:%u lapm:%u access=call:%u ans:%u dig:%u pcm=a:%u d:%u v91:%u flags=%02x/%02x/%02x\n",
		  cfg->answer_mode ? "answer" : "originate",
		  cfg->target_dp_id,
		  cfg->sample_rate,
		  cfg->advertise.data,
		  cfg->advertise.v92,
		  cfg->advertise.v90,
		  cfg->advertise.v34,
		  cfg->advertise.v32,
		  cfg->advertise.v22,
		  engine->quick_connect_enabled,
		  engine->lapm_requested,
		  cfg->advertise.access_call_cellular,
		  cfg->advertise.access_answer_cellular,
		  cfg->advertise.access_digital,
		  cfg->advertise.pcm_analog,
		  cfg->advertise.pcm_digital,
		  cfg->advertise.pcm_v91,
		  engine->initial_flags0,
		  engine->initial_flags1,
		  engine->initial_flags2);
	return engine;
}

void v8_open_delete(void *engine_ptr)
{
	struct v8_open_engine *engine = engine_ptr;
	free(engine);
}

int v8_open_process(void *engine_ptr, void *in, void *out, int cnt)
{
	struct v8_open_engine *engine = engine_ptr;
	const void *rx_in;
	const short *rx_samples;
	short rx_step_buf[4];
	int rx_remaining;
	int rx_step;
	int j;
	unsigned budget;
	int ret;

	if (!engine)
		return V8_OPEN_STATUS_INIT;

	/*
	 * Feed V.8 detector/demod with the raw receive stream. Blob V8agc +
	 * v8_fskdemodulate operate directly on queued RX PCM; additional
	 * preconditioning here biases the bit discriminator toward one rail.
	 */
	rx_in = in;

	/*
	 * Blob V8Process consumes RX through a small queue and advances the
	 * handshake/detector logic in short strides. Large one-shot chunks make
	 * our framing counters jump and bias lock/fallback behavior.
	 */
	if (rx_in && cnt > 0) {
		rx_samples = (const short *)rx_in;
		rx_remaining = cnt;
		while (rx_remaining > 0) {
			/*
			 * Keep V.8 RX progression sample-granular to match blob
			 * detector/demod pacing. 4-sample batching can smear
			 * symbol timing and hurt CM framing stability.
			 */
			rx_step = 1;
			for (j = 0; j < rx_step; ++j)
				rx_step_buf[j] =
					v8_open_rx_frontend_sample(engine, rx_samples[j]);
			v8_open_observe_cm(engine, rx_step_buf, rx_step);
			v8_open_observe_cj(engine, rx_step_buf, rx_step);
			rx_samples += rx_step;
			rx_remaining -= rx_step;
		}
	} else {
		v8_open_observe_cm(engine, rx_in, cnt);
		v8_open_observe_cj(engine, rx_in, cnt);
	}

	v8_open_emit_phase(engine, out, cnt);

	if (engine->phase == V8_OPEN_PHASE_COMPLETE) {
		engine->last_status = V8_OPEN_STATUS_OK;
		ret = (int)engine->last_status;
		goto out;
	}

	engine->total_samples += (unsigned)cnt;
	engine->samples_in_phase += (unsigned)cnt;
	engine->last_status = v8_open_phase_status(engine, engine->phase);

	/*
	 * CI/CNG tone detection during ANS_WAIT_FOR_CI phase.
	 * Blob answer mode starts in silence (TX=0x05) and calls
	 * v8_tone_detect() each tick; ANSam only starts after the
	 * calling modem's tone is detected.  We use a simple energy
	 * detector: if average |sample| exceeds a threshold for
	 * enough consecutive blocks, consider the tone present.
	 */
	if (engine->phase == V8_OPEN_PHASE_ANS_WAIT_FOR_CI &&
	    !engine->ci_detected && in && cnt > 0) {
		const short *rx_pcm = (const short *)in;
		unsigned energy = 0U;
		int k;

		for (k = 0; k < cnt; ++k) {
			int v = (int)rx_pcm[k];
			energy += (unsigned)(v < 0 ? -v : v);
		}
		energy /= (unsigned)cnt;
		if (energy >= V8OPEN_CI_DETECT_THRESHOLD) {
			engine->ci_energy_counter++;
			if (engine->ci_energy_counter >= V8OPEN_CI_DETECT_FRAMES) {
				engine->ci_detected = 1U;
				V8OPEN_DBG("ci-detect: tone detected at sample %u "
					  "(energy=%u, elapsed=%u ms)\n",
					  engine->total_samples, energy,
					  engine->samples_in_phase *
					  1000U /
					  (engine->cfg.sample_rate ?
					   engine->cfg.sample_rate : 9600U));
				/* Force immediate transition to ANSam. */
				v8_open_transition(engine,
						   V8_OPEN_PHASE_ANS_SEND_ANSAM);
			}
		} else {
			engine->ci_energy_counter = 0U;
		}
	}

	budget = v8_open_phase_budget(engine, engine->phase);
	while (budget && engine->samples_in_phase >= budget) {
		engine->samples_in_phase -= budget;
		v8_open_transition(engine, v8_open_next_phase(engine, engine->phase));
		if (engine->phase == V8_OPEN_PHASE_COMPLETE)
			break;
		budget = v8_open_phase_budget(engine, engine->phase);
	}

	ret = (int)engine->last_status;
out:
	return ret;
}

int v8_open_answer_cm_timeout(const void *engine_ptr)
{
	const struct v8_open_engine *engine;

	engine = (const struct v8_open_engine *)engine_ptr;
	if (!engine)
		return 0;
	if (!engine->cfg.answer_mode)
		return 0;

	return engine->ans_cm_timeout_fallback ? 1 : 0;
}

int v8_open_answer_cj_timeout(const void *engine_ptr)
{
	const struct v8_open_engine *engine;

	engine = (const struct v8_open_engine *)engine_ptr;
	if (!engine)
		return 0;
	if (!engine->cfg.answer_mode)
		return 0;

	return engine->ans_cj_timeout_fallback ? 1 : 0;
}

int v8_open_answer_recommended_dp(const void *engine_ptr)
{
	const struct v8_open_engine *engine;

	engine = (const struct v8_open_engine *)engine_ptr;
	if (!engine)
		return 0;

	return (int)engine->preferred_dp;
}

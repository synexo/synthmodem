/*
 *
 *    dp_v8_shim.c - logging shim around the proprietary V.8 datapump adapter.
 *
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include <modem.h>
#include <modem_debug.h>
#include <modem_param.h>
#include "v8_open.h"

#define V8_STATUS_LAST 17
#define V8SHIM_DBG(fmt,args...) dprintf("v8shim: " fmt, ##args)

struct v8_runtime_partial {
	unsigned char flags0;
	unsigned char flags1;
	unsigned char flags2;
	unsigned char flags3;
	unsigned rate_a;
	unsigned rate_b;
	unsigned reserved_0c;
	unsigned qc_index;
};

struct v8_blob_wrapper {
	struct dp base;
	unsigned answer_mode;
	enum DP_ID target_dp_id;
	unsigned reserved_1c;
	int handoff_delay;
	struct dsp_info *dsp_info;
	struct v8_runtime_partial *dp_runtime;
	unsigned last_v8_status;
	void *v8_engine;
};

struct v8_shim_state {
	struct dp *inner;
	struct dp_operations *real_ops;
	unsigned last_status;
	int last_return_code;
	int last_handoff_delay;
	long last_dp_requested;
	long last_update_delay;
	unsigned last_qc_lapm;
	unsigned last_qc_index;
	unsigned char last_flags0;
	unsigned char last_flags1;
	unsigned char last_flags2;
	int use_open_stub;
	int handoff_emitted;
	enum DP_ID open_next_dp;
	enum DP_ID open_timeout_dp;
	struct v8_shim_state *next;
};

static struct dp_operations *real_v8_ops;
static struct v8_shim_state *v8_shim_states;
static int use_open_stub;

static const char *v8_status_name(unsigned status)
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
	case V8_OPEN_STATUS_ANS_SEND_JM:
		return "V8_ANS_SEND_JM";
	case V8_OPEN_STATUS_ORG_WAITING_FOR_QCA1D:
		return "V8_ORG_WAITING_FOR_QCA1d";
	case V8_OPEN_STATUS_OK:
		return "V8_OK";
	default:
		break;
	}
	if (status <= V8_STATUS_LAST)
		return "V8_STATUS?";
	return "V8_UNKNOWN";
}

static struct v8_shim_state *v8_shim_find(struct dp *dp)
{
	struct v8_shim_state *state;

	for (state = v8_shim_states; state; state = state->next) {
		if (state->inner == dp)
			return state;
	}

	return NULL;
}

static void v8_shim_add(struct v8_shim_state *state)
{
	state->next = v8_shim_states;
	v8_shim_states = state;
}

static struct v8_shim_state *v8_shim_take(struct dp *dp)
{
	struct v8_shim_state **link;

	for (link = &v8_shim_states; *link; link = &(*link)->next) {
		if ((*link)->inner == dp) {
			struct v8_shim_state *state = *link;
			*link = state->next;
			state->next = NULL;
			return state;
		}
	}

	return NULL;
}

static void v8_shim_log_snapshot(const char *phase,
				 struct v8_shim_state *state,
				 struct v8_blob_wrapper *blob,
				 int ret,
				 int force)
{
	long dp_requested;
	long update_delay;
	unsigned qc_lapm;
	unsigned qc_index;
	unsigned char flags0;
	unsigned char flags1;
	unsigned char flags2;

	dp_requested = modem_get_param(blob->base.modem, MDMPRM_DP_REQUESTED);
	update_delay = modem_get_param(blob->base.modem, MDMPRM_UPDATE_DELAY);
	qc_lapm = blob->dsp_info ? blob->dsp_info->qc_lapm : 0;
	qc_index = blob->dsp_info ? blob->dsp_info->qc_index : 0;
	flags0 = blob->dp_runtime ? blob->dp_runtime->flags0 : 0;
	flags1 = blob->dp_runtime ? blob->dp_runtime->flags1 : 0;
	flags2 = blob->dp_runtime ? blob->dp_runtime->flags2 : 0;

	if (!force &&
	    state->last_status == blob->last_v8_status &&
	    state->last_return_code == ret &&
	    state->last_handoff_delay == blob->handoff_delay &&
	    state->last_dp_requested == dp_requested &&
	    state->last_update_delay == update_delay &&
	    state->last_qc_lapm == qc_lapm &&
	    state->last_qc_index == qc_index &&
	    state->last_flags0 == flags0 &&
	    state->last_flags1 == flags1 &&
	    state->last_flags2 == flags2)
		return;

	V8SHIM_DBG("%s: ret=%d status=%u(%s) target=%d answer=%u delay=%d dp_requested=%ld update_delay=%ld qc_lapm=%u qc_index=%u flags=%02x/%02x/%02x engine=%p\n",
		  phase,
		  ret,
		  blob->last_v8_status,
		  v8_status_name(blob->last_v8_status),
		  blob->target_dp_id,
		  blob->answer_mode,
		  blob->handoff_delay,
		  dp_requested,
		  update_delay,
		  qc_lapm,
		  qc_index,
		  flags0,
		  flags1,
		  flags2,
		  blob->v8_engine);

	state->last_status = blob->last_v8_status;
	state->last_return_code = ret;
	state->last_handoff_delay = blob->handoff_delay;
	state->last_dp_requested = dp_requested;
	state->last_update_delay = update_delay;
	state->last_qc_lapm = qc_lapm;
	state->last_qc_index = qc_index;
	state->last_flags0 = flags0;
	state->last_flags1 = flags1;
	state->last_flags2 = flags2;
}

static int v8_shim_env_enabled(const char *name, int default_value)
{
	const char *value;

	value = getenv(name);
	if (!value || !value[0])
		return default_value;

	if (strcmp(value, "0") == 0 ||
	    strcasecmp(value, "false") == 0 ||
	    strcasecmp(value, "no") == 0 ||
	    strcasecmp(value, "off") == 0)
		return 0;

	return 1;
}

static void v8_shim_fill_open_caps(struct v8_open_create_cfg *cfg,
				   enum DP_ID target_dp_id,
				   const struct v8_runtime_partial *dp_runtime)
{
	unsigned char flags2;
	int default_access_digital;
	int default_pcm_analog;
	int default_pcm_digital;
	int default_v92;
	int default_v90;
	int default_v34;
	int default_v32;
	int default_v22;

	flags2 = dp_runtime ? dp_runtime->flags2 : 0;
	default_access_digital = v8_shim_env_enabled("SLMODEMD_V8_ACCESS_DIGITAL", 0);
	default_v92 = default_access_digital && target_dp_id == DP_V92;
	default_v90 = target_dp_id == DP_V92 ||
		target_dp_id == DP_V90 ||
		target_dp_id == DP_V90_NO_V8BIS;
	default_v90 = default_access_digital && default_v90;
	default_v34 = target_dp_id == DP_V92 ||
		target_dp_id == DP_V90 ||
		target_dp_id == DP_V90_NO_V8BIS ||
		target_dp_id == DP_V34 ||
		target_dp_id == DP_V34BIS;
	default_v32 = default_v34 ||
		target_dp_id == DP_V32 ||
		target_dp_id == DP_V32BIS;
	default_v22 = target_dp_id == DP_V22 ||
		target_dp_id == DP_V22BIS;
	default_pcm_analog = target_dp_id == DP_V92 ||
		target_dp_id == DP_V90 ||
		target_dp_id == DP_V90_NO_V8BIS;
	default_pcm_digital = default_access_digital && default_v90;

	memset(&cfg->advertise, 0, sizeof(cfg->advertise));
	cfg->advertise.data = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_DATA", 1);
	cfg->advertise.v92 = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_V92", default_v92);
	cfg->advertise.v90 = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_V90", default_v90);
	cfg->advertise.v34 = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_V34", default_v34);
	cfg->advertise.v32 = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_V32", default_v32);
	cfg->advertise.v22 = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_V22", default_v22);
	cfg->advertise.quick_connect = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_QC",
							default_access_digital &&
							((flags2 & 0x10U) != 0));
	cfg->advertise.lapm = (unsigned)v8_shim_env_enabled("SLMODEMD_V8_REPORT_LAPM",
					      (flags2 & 0x40U) != 0);
	cfg->advertise.access_call_cellular = (unsigned)v8_shim_env_enabled(
		"SLMODEMD_V8_ACCESS_CALL_CELLULAR", 0);
	cfg->advertise.access_answer_cellular = (unsigned)v8_shim_env_enabled(
		"SLMODEMD_V8_ACCESS_ANSWER_CELLULAR", 0);
	cfg->advertise.access_digital = (unsigned)default_access_digital;
	cfg->advertise.pcm_analog = (unsigned)v8_shim_env_enabled(
		"SLMODEMD_V8_PCM_ANALOG", default_pcm_analog);
	cfg->advertise.pcm_digital = (unsigned)v8_shim_env_enabled(
		"SLMODEMD_V8_PCM_DIGITAL", default_pcm_digital);
	cfg->advertise.pcm_v91 = (unsigned)v8_shim_env_enabled(
		"SLMODEMD_V8_PCM_V91", 0);
}

static void v8_shim_seed_open_runtime(struct v8_blob_wrapper *blob,
				      const struct v8_open_create_cfg *cfg)
{
	unsigned char flags0;
	unsigned char flags1;
	unsigned char flags2;
	unsigned qc_index;
	int originator;

	if (!blob->dp_runtime)
		return;

	/*
	 * Mirror documented blob create-time behavior:
	 * - flags0: clear bit1, seed V.90/V.34/V.32 capability bits
	 * - flags1: seed LAPM capability bit (0x40)
	 * - flags2: seed QC bit (0x10) only for originator V.92 path
	 *           (leave LAPM-negotiated bit 0x40 for update-time logic)
	 */
	originator = (cfg->answer_mode == 0U);
	flags0 = blob->dp_runtime->flags0;
	flags1 = blob->dp_runtime->flags1;
	flags2 = blob->dp_runtime->flags2;
	qc_index = blob->dp_runtime->qc_index;

	flags0 = (unsigned char)(flags0 & (unsigned char)~0x02U);
	if (cfg->advertise.v90 &&
	    (originator ||
	     cfg->advertise.access_digital) &&
	    (cfg->target_dp_id == (unsigned)DP_V92 ||
	     cfg->target_dp_id == (unsigned)DP_V90 ||
	     cfg->target_dp_id == (unsigned)DP_V90_NO_V8BIS))
		flags0 = (unsigned char)(flags0 | 0x08U);
	else
		flags0 = (unsigned char)(flags0 & (unsigned char)~0x08U);
	if (cfg->advertise.v34)
		flags0 = (unsigned char)(flags0 | 0x20U);
	else
		flags0 = (unsigned char)(flags0 & (unsigned char)~0x20U);
	if (cfg->advertise.v32)
		flags0 = (unsigned char)(flags0 | 0x80U);
	else
		flags0 = (unsigned char)(flags0 & (unsigned char)~0x80U);

	if (cfg->advertise.lapm)
		flags1 = (unsigned char)(flags1 | 0x40U);
	else
		flags1 = (unsigned char)(flags1 & (unsigned char)~0x40U);

	flags2 = (unsigned char)(flags2 & (unsigned char)~(0x10U | 0x40U));
	if ((originator &&
	     cfg->target_dp_id == (unsigned)DP_V92 &&
	     cfg->advertise.quick_connect) ||
	    cfg->advertise.access_digital)
		flags2 = (unsigned char)(flags2 | 0x10U);

	if (!qc_index)
		qc_index = 9U;

	blob->dp_runtime->flags0 = flags0;
	blob->dp_runtime->flags1 = flags1;
	blob->dp_runtime->flags2 = flags2;
	blob->dp_runtime->qc_index = qc_index;
}

static int v8_shim_open_cap_enabled(const struct v8_open_advertise_cfg *caps,
				    enum DP_ID candidate)
{
	switch (candidate) {
	case DP_V92:
		return caps->v92 != 0;
	case DP_V90:
		return caps->v90 != 0;
	case DP_V34:
		return caps->v34 != 0;
	case DP_V32:
		return caps->v32 != 0;
	case DP_V22:
		return caps->v22 != 0;
	default:
		return 0;
	}
}

static int v8_shim_open_target_allows(enum DP_ID target_dp_id,
				      enum DP_ID candidate)
{
	switch (target_dp_id) {
	case DP_V92:
		return candidate == DP_V92 ||
			candidate == DP_V90 ||
			candidate == DP_V34 ||
			candidate == DP_V32 ||
			candidate == DP_V22;
	case DP_V90:
	case DP_V90_NO_V8BIS:
		return candidate == DP_V90 ||
			candidate == DP_V34 ||
			candidate == DP_V32 ||
			candidate == DP_V22;
	case DP_V34:
	case DP_V34BIS:
		return candidate == DP_V34 ||
			candidate == DP_V32 ||
			candidate == DP_V22;
	case DP_V32:
	case DP_V32BIS:
		return candidate == DP_V32 ||
			candidate == DP_V22;
	case DP_V22:
	case DP_V22BIS:
		return candidate == DP_V22;
	default:
		return candidate == target_dp_id;
	}
}

static enum DP_ID v8_shim_open_next_dp(enum DP_ID target_dp_id,
				       const struct v8_open_advertise_cfg *caps)
{
	static const enum DP_ID fallback_order[] = {
		DP_V92,
		DP_V90,
		DP_V34,
		DP_V32,
		DP_V22
	};
	unsigned i;

	for (i = 0; i < sizeof(fallback_order) / sizeof(fallback_order[0]); ++i) {
		enum DP_ID candidate = fallback_order[i];

		if (!v8_shim_open_target_allows(target_dp_id, candidate))
			continue;
		if ((candidate == DP_V92 || candidate == DP_V90) &&
		    (!caps->access_digital || !caps->pcm_digital))
			continue;
		if (!v8_shim_open_cap_enabled(caps, candidate))
			continue;
		return candidate;
	}

	return target_dp_id;
}

static enum DP_ID v8_shim_open_timeout_dp(enum DP_ID target_dp_id,
					  const struct v8_open_advertise_cfg *caps)
{
	static const enum DP_ID fallback_order[] = {
		DP_V32,
		DP_V22
	};
	unsigned i;

	for (i = 0; i < sizeof(fallback_order) / sizeof(fallback_order[0]); ++i) {
		enum DP_ID candidate = fallback_order[i];

		if (!v8_shim_open_target_allows(target_dp_id, candidate))
			continue;
		if (!v8_shim_open_cap_enabled(caps, candidate))
			continue;
		return candidate;
	}

	return v8_shim_open_next_dp(target_dp_id, caps);
}

static int v8_shim_open_handoff(struct v8_blob_wrapper *blob,
				struct v8_shim_state *state,
				unsigned status)
{
	enum DP_ID next_dp;
	unsigned force_conservative_runtime;
	unsigned no_cj_timeout_fallback;
	long io_delay;
	int qc_handoff;

	if (state->handoff_emitted)
		return 0;

	next_dp = state->open_next_dp;
	no_cj_timeout_fallback = 0U;
	qc_handoff = (status == V8_OPEN_STATUS_ORG_WAITING_FOR_QCA1D);
	if (qc_handoff) {
		if (blob->target_dp_id != DP_V90 &&
		    blob->target_dp_id != DP_V90_NO_V8BIS &&
		    blob->target_dp_id != DP_V92) {
			V8SHIM_DBG("open handoff: QC status with invalid target=%d\n",
				  blob->target_dp_id);
			return -1;
		}
		next_dp = DP_V92;
	}

	if (state->use_open_stub &&
	    blob->v8_engine &&
	    v8_open_answer_cm_timeout(blob->v8_engine)) {
		next_dp = state->open_timeout_dp;
		V8SHIM_DBG("open handoff: no-CM timeout fallback, forcing next_dp=%d target=%d\n",
			  next_dp,
			  blob->target_dp_id);
	} else if (state->use_open_stub &&
		   blob->v8_engine &&
		   v8_open_answer_cj_timeout(blob->v8_engine)) {
		int recommended_dp;

		recommended_dp = v8_open_answer_recommended_dp(blob->v8_engine);
		if (recommended_dp == DP_V92 || recommended_dp == DP_V90)
			recommended_dp = DP_V34;
		if (recommended_dp > 0 &&
		    v8_shim_open_target_allows(blob->target_dp_id,
					       (enum DP_ID)recommended_dp)) {
			next_dp = (enum DP_ID)recommended_dp;
		} else {
			next_dp = state->open_timeout_dp;
		}
		V8SHIM_DBG("open handoff: no-CJ timeout fallback, forcing next_dp=%d target=%d preferred=%d\n",
			  next_dp,
			  blob->target_dp_id,
			  recommended_dp);
		no_cj_timeout_fallback = 1U;
	}
	force_conservative_runtime = (next_dp == state->open_timeout_dp) ? 1U : 0U;
	if (no_cj_timeout_fallback && next_dp == DP_V34) {
		force_conservative_runtime = 1U;
		V8SHIM_DBG("open handoff: no-CJ V34 fallback, using conservative runtime seeding\n");
	}
	io_delay = modem_get_param(blob->base.modem, MDMPRM_IODELAY);
	blob->handoff_delay = (int)(io_delay + 0x270);

	if (blob->dsp_info) {
		if (qc_handoff)
			blob->dsp_info->qc_lapm &= 1U;
		if (force_conservative_runtime) {
			blob->dsp_info->qc_lapm = 0;
			blob->dsp_info->qc_index = 9;
		}
	}

	if (blob->dp_runtime) {
		blob->dp_runtime->flags0 |= 0x01;
		if (qc_handoff)
			blob->dp_runtime->flags2 |= 0x10U;
		if (force_conservative_runtime) {
			blob->dp_runtime->flags2 = 0x00;
			blob->dp_runtime->qc_index = 9;
		}
	}

	modem_set_param(blob->base.modem, MDMPRM_DP_REQUESTED, next_dp);
	state->handoff_emitted = 1;
	return 0;
}

static struct dp *v8_shim_create_open(struct modem *m, enum DP_ID id,
				      int caller, int srate,
				      struct dp_operations *op)
{
	struct v8_blob_wrapper *blob;
	struct v8_shim_state *state;
	struct v8_open_create_cfg cfg;

	blob = calloc(1, sizeof(*blob));
	if (!blob)
		return NULL;

	state = calloc(1, sizeof(*state));
	if (!state) {
		free(blob);
		return NULL;
	}

	blob->base.id = DP_V8;
	blob->base.modem = m;
	blob->base.status = 0;
	blob->base.op = op;
	blob->base.dp_data = blob;
	blob->answer_mode = caller ? 0U : 1U;
	blob->target_dp_id = id;
	blob->dsp_info = (struct dsp_info *)modem_get_param(m, MDMPRM_DSPINFO);
	blob->dp_runtime = (struct v8_runtime_partial *)modem_get_param(m, MDMPRM_DPRUNTIME);
	blob->last_v8_status = V8_OPEN_STATUS_INIT;
	blob->handoff_delay = 0;

	cfg.answer_mode = blob->answer_mode;
	cfg.target_dp_id = (unsigned)id;
	cfg.reserved_04 = 0;
	cfg.signal_detect_timeout_secs = 12;
	cfg.message_detect_timeout_secs = 7;
	cfg.sample_rate = (unsigned)srate;
	cfg.dp_runtime = blob->dp_runtime;
	v8_shim_fill_open_caps(&cfg, id, blob->dp_runtime);
	v8_shim_seed_open_runtime(blob, &cfg);

	blob->v8_engine = v8_open_create(&cfg);
	if (!blob->v8_engine) {
		free(state);
		free(blob);
		return NULL;
	}

	state->inner = &blob->base;
	state->real_ops = NULL;
	state->last_status = ~0U;
	state->last_return_code = -9999;
	state->last_handoff_delay = 0x7fffffff;
	state->last_dp_requested = -9999;
	state->last_update_delay = -9999;
	state->last_qc_lapm = ~0U;
	state->last_qc_index = ~0U;
	state->last_flags0 = 0xff;
	state->last_flags1 = 0xff;
	state->last_flags2 = 0xff;
	state->use_open_stub = 1;
	state->handoff_emitted = 0;
	state->open_next_dp = v8_shim_open_next_dp(id, &cfg.advertise);
	state->open_timeout_dp = v8_shim_open_timeout_dp(id, &cfg.advertise);

	v8_shim_add(state);
	v8_shim_log_snapshot("create-open", state, blob, 0, 1);
	return &blob->base;
}

static struct dp *v8_shim_create(struct modem *m, enum DP_ID id,
				 int caller, int srate, int max_frag,
				 struct dp_operations *op)
{
	struct dp *inner;
	struct v8_blob_wrapper *blob;
	struct v8_shim_state *state;

	if (use_open_stub)
		return v8_shim_create_open(m, id, caller, srate, op);

	if (!real_v8_ops || !real_v8_ops->create)
		return NULL;

	inner = real_v8_ops->create(m, id, caller, srate, max_frag, real_v8_ops);
	if (!inner)
		return NULL;

	state = calloc(1, sizeof(*state));
	if (!state) {
		real_v8_ops->delete(inner);
		return NULL;
	}

	state->inner = inner;
	state->real_ops = real_v8_ops;
	state->last_status = ~0U;
	state->last_return_code = -9999;
	state->last_handoff_delay = 0x7fffffff;
	state->last_dp_requested = -9999;
	state->last_update_delay = -9999;
	state->last_qc_lapm = ~0U;
	state->last_qc_index = ~0U;
	state->last_flags0 = 0xff;
	state->last_flags1 = 0xff;
	state->last_flags2 = 0xff;
	state->use_open_stub = 0;
	state->handoff_emitted = 0;

	inner->op = op;
	v8_shim_add(state);

	blob = (struct v8_blob_wrapper *)inner;
	v8_shim_log_snapshot("create", state, blob, 0, 1);
	return inner;
}

static int v8_shim_delete(struct dp *dp)
{
	struct v8_blob_wrapper *blob;
	struct v8_shim_state *state;
	int ret;

	state = v8_shim_take(dp);
	if (!state)
		return -1;

	blob = (struct v8_blob_wrapper *)dp;
	v8_shim_log_snapshot("delete", state, blob, state->last_return_code, 1);

	if (state->use_open_stub) {
		v8_open_delete(blob->v8_engine);
		free(dp);
		ret = 0;
	} else {
		if (!state->real_ops || !state->real_ops->delete) {
			free(state);
			return -1;
		}
		dp->op = state->real_ops;
		ret = state->real_ops->delete(dp);
	}
	free(state);
	return ret;
}

static int v8_shim_process(struct dp *dp, void *in, void *out, int cnt)
{
	struct v8_blob_wrapper *blob;
	struct v8_shim_state *state;
	int ret;
	int status;
	int suppress_log;

	state = v8_shim_find(dp);
	if (!state)
		return -1;

	blob = (struct v8_blob_wrapper *)dp;
	suppress_log = 0;
	if (state->use_open_stub) {
		status = v8_open_process(blob->v8_engine, in, out, cnt);
		blob->last_v8_status = (unsigned)status;
		ret = DPSTAT_OK;
		if (status == V8_OPEN_STATUS_OK ||
		    status == V8_OPEN_STATUS_ORG_WAITING_FOR_QCA1D ||
		    status == V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CM ||
		    status == V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CJ) {
			if (v8_shim_open_handoff(blob, state, (unsigned)status) < 0)
				ret = DPSTAT_ERROR;
			if (ret == DPSTAT_OK && blob->handoff_delay > cnt) {
				blob->handoff_delay -= cnt;
				suppress_log = 1;
			} else if (ret == DPSTAT_OK) {
				blob->handoff_delay = 0;
				ret = DPSTAT_CHANGEDP;
			}
		}
	} else {
		if (!state->real_ops || !state->real_ops->process)
			return -1;
		ret = state->real_ops->process(dp, in, out, cnt);
	}
	if (!suppress_log)
		v8_shim_log_snapshot("process", state, blob, ret, 0);
	return ret;
}

static int v8_shim_hangup(struct dp *dp)
{
	struct v8_blob_wrapper *blob;
	struct v8_shim_state *state;

	state = v8_shim_find(dp);
	if (!state)
		return 0;

	blob = (struct v8_blob_wrapper *)dp;
	v8_shim_log_snapshot("hangup", state, blob, state->last_return_code, 1);

	if (!state->use_open_stub && state->real_ops && state->real_ops->hangup)
		return state->real_ops->hangup(dp);

	return 0;
}

static struct dp_operations v8_shim_ops = {
	.name = "V8 shim",
	.use_count = 0,
	.create = v8_shim_create,
	.delete = v8_shim_delete,
	.process = v8_shim_process,
	.hangup = v8_shim_hangup,
};

int dp_v8_shim_init(void)
{
	struct dp_operations *current;
	const char *mode;
	int requested_open_stub;

	mode = getenv("SLMODEMD_V8_OPEN_STUB");
	requested_open_stub = mode && mode[0] && strcmp(mode, "0") != 0;
	use_open_stub = requested_open_stub;

	current = modem_dp_get_ops(DP_V8);
	if (!current) {
		if (!use_open_stub)
			return 0;
		if (modem_dp_register(DP_V8, &v8_shim_ops) < 0)
			return -1;
		V8SHIM_DBG("installed shim in open-stub mode (no proprietary DP_V8)\n");
		return 0;
	}

	if (current == &v8_shim_ops)
		return 0;

	/*
	 * Blob replacement policy: if proprietary DP_V8 exists, normally use
	 * it.  However, when digital-side mode is active the blob's V.8
	 * engine cannot negotiate V.90/V.92 on the answer side (its
	 * rebuildJMSequence requires the REMOTE CM to indicate digital access,
	 * which an analog caller will never set).  In that case the open stub
	 * is required for correct digital capability advertisement.
	 */
	if (requested_open_stub &&
	    !v8_shim_env_enabled("SLMODEMD_V8_ACCESS_DIGITAL", 0)) {
		use_open_stub = 0;
		V8SHIM_DBG("SLMODEMD_V8_OPEN_STUB requested but proprietary DP_V8 is present; forcing blob path\n");
	} else if (v8_shim_env_enabled("SLMODEMD_V8_ACCESS_DIGITAL", 0)) {
		use_open_stub = 1;
		V8SHIM_DBG("SLMODEMD_V8_ACCESS_DIGITAL active; forcing open stub for digital-side V.8 negotiation\n");
	}

	real_v8_ops = current;
	modem_dp_deregister(DP_V8, current);
	if (modem_dp_register(DP_V8, &v8_shim_ops) < 0) {
		modem_dp_register(DP_V8, current);
		real_v8_ops = NULL;
		return -1;
	}

	V8SHIM_DBG("installed shim around proprietary DP_V8 ops%s\n",
		  use_open_stub ? " (open stub enabled)" : "");
	return 0;
}

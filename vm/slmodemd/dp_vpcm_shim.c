/*
 *
 *    dp_vpcm_shim.c - logging shim around the proprietary VPCM datapump adapters.
 *
 */

#include <stdlib.h>
#include <string.h>

#include <modem.h>
#include <modem_debug.h>
#include <modem_param.h>

#define VPCMSHIM_DBG(fmt,args...) dprintf("vpcmshim: " fmt, ##args)

#define VPCMSHIM_STUB_CONNECT_DELAY_DIV 2
#define VPCMSHIM_STUB_DEFAULT_LOG_MS    1000

enum vpcm_shim_stub_mode {
	VPCMSHIM_STUB_DISABLED = 0,
	VPCMSHIM_STUB_CONNECT,
	VPCMSHIM_STUB_ERROR,
};

struct vpcm_stub_dp {
	struct dp dp;
};

struct vpcm_runtime_prefix {
	unsigned char flags0;
	unsigned char flags1;
	unsigned char flags2;
	unsigned char flags3;
	unsigned rate_a;
	unsigned rate_b;
	unsigned reserved_0c;
	unsigned qc_index;
};

struct vpcm_shim_state {
	struct dp *inner;
	struct dp_operations *real_ops;
	enum DP_ID target_dp_id;
	int caller;
	int srate;
	int max_frag;
	int frag_ms;
	int vpcmx_side;
	int session_type;
	int last_ret;
	int use_stub;
	int stub_connected;
	int stub_bit_bridge;
	int stub_force_ec;
	int stub_pack_promoted;
	int stub_loopback;
	enum vpcm_shim_stub_mode stub_mode;
	unsigned long total_samples;
	unsigned long linked_samples;
	unsigned long stub_connect_samples;
	unsigned long stub_drop_samples;
	unsigned long stub_log_interval_samples;
	unsigned long stub_next_log_samples;
	unsigned status;
	u8 stub_bits[1024];
	struct vpcm_shim_state *next;
};

static struct dp_operations *real_v34_ops;
static struct dp_operations *real_v90_ops;
static struct dp_operations *real_v92_ops;
static struct vpcm_shim_state *vpcm_shim_states;
static int vpcm_digital_side;

/*
 * VPCMXF_Create interposer via symbol weakening.
 *
 * The blob's vpcm_create() hardcodes side=0 (Analog) when calling
 * VPCMXF_Create(). When operating as a digital PCM endpoint (ISP side
 * over VoIP), we need side=1 (Digital) so the V.90/V.92 modem engine
 * runs the correct PCM codec path.
 *
 * dsplibs.o has been patched with objcopy:
 *   --weaken-symbol=VPCMXF_Create  (makes the blob's definition weak)
 *   --add-symbol __blob_VPCMXF_Create=.text:0xfcf0,global,function
 *                                    (alias to call the original code)
 *
 * This strong definition overrides the blob's weak one for ALL callers,
 * including the intra-object call from vpcm_create() within dsplibs.o.
 *
 * Prototype inferred from VPCMXF_Create disassembly: 5 args passed on
 * the x86-32 stack, forwarded to VPcmFloModem constructor.
 */
extern void *__blob_VPCMXF_Create(int side, void *v34_obj,
				  void *dp_runtime, unsigned frag_ms,
				  int session_type);

void *VPCMXF_Create(int side, void *v34_obj,
		    void *dp_runtime, unsigned frag_ms,
		    int session_type)
{
	if (vpcm_digital_side) {
		VPCMSHIM_DBG("VPCMXF_Create: overriding side %d -> 1 (Digital)\n",
			    side);
		side = 1;
	}
	return __blob_VPCMXF_Create(side, v34_obj, dp_runtime,
				    frag_ms, session_type);
}

static struct dp_operations *vpcm_shim_real_ops(enum DP_ID id)
{
	switch (id) {
	case DP_V34:
	case DP_V34BIS:
		return real_v34_ops;
	case DP_V90:
	case DP_V90_NO_V8BIS:
		return real_v90_ops;
	case DP_V92:
		return real_v92_ops;
	default:
		return NULL;
	}
}

static int vpcm_shim_session_type(enum DP_ID id)
{
	if (id == DP_V92)
		return 2;
	if (id == DP_V90 || id == DP_V90_NO_V8BIS)
		return 1;
	return 0;
}

static const char *vpcm_shim_side_name(int side)
{
	return side ? "Digital" : "Analog";
}

static const char *vpcm_shim_stub_mode_name(enum vpcm_shim_stub_mode mode)
{
	switch (mode) {
	case VPCMSHIM_STUB_CONNECT:
		return "connect";
	case VPCMSHIM_STUB_ERROR:
		return "error";
	default:
		return "disabled";
	}
}

static int vpcm_shim_env_false(const char *value)
{
	if (!value)
		return 1;

	return !strcmp(value, "0") ||
	       !strcmp(value, "false") ||
	       !strcmp(value, "no") ||
	       !strcmp(value, "off");
}

static enum vpcm_shim_stub_mode vpcm_shim_get_stub_mode(void)
{
	const char *value = getenv("SLMODEMD_VPCM_OPEN_STUB");

	if (!value || vpcm_shim_env_false(value))
		return VPCMSHIM_STUB_DISABLED;
	if (!strcmp(value, "error"))
		return VPCMSHIM_STUB_ERROR;

	return VPCMSHIM_STUB_CONNECT;
}

static int vpcm_shim_stub_allowed(enum DP_ID id)
{
	switch (id) {
	case DP_V34:
	case DP_V34BIS:
		return 0;
	default:
		return 1;
	}
}

static unsigned long vpcm_shim_millis_to_samples(int srate, unsigned long ms)
{
	if (srate <= 0 || !ms)
		return 0;

	return (unsigned long)((ms * (unsigned long)srate) / 1000UL);
}

static unsigned long vpcm_shim_parse_ulong_env(const char *name,
					       unsigned long fallback)
{
	const char *value = getenv(name);
	char *endptr;
	unsigned long parsed;

	if (!value || !*value)
		return fallback;

	parsed = strtoul(value, &endptr, 10);
	if (!endptr || *endptr)
		return fallback;

	return parsed;
}

static int vpcm_shim_get_stub_loopback(void)
{
	const char *value = getenv("SLMODEMD_VPCM_STUB_LOOPBACK");

	if (!value || vpcm_shim_env_false(value))
		return 0;

	return 1;
}

static int vpcm_shim_get_stub_bit_bridge(void)
{
	const char *value = getenv("SLMODEMD_VPCM_STUB_BIT_BRIDGE");

	if (!value)
		return 1;
	if (vpcm_shim_env_false(value))
		return 0;

	return 1;
}

static int vpcm_shim_get_stub_force_ec(void)
{
	const char *value = getenv("SLMODEMD_VPCM_STUB_FORCE_EC");

	if (!value)
		return 1;
	if (vpcm_shim_env_false(value))
		return 0;

	return 1;
}

static struct vpcm_shim_state *vpcm_shim_find(struct dp *dp)
{
	struct vpcm_shim_state *state;

	for (state = vpcm_shim_states; state; state = state->next) {
		if (state->inner == dp)
			return state;
	}

	return NULL;
}

static void vpcm_shim_add(struct vpcm_shim_state *state)
{
	state->next = vpcm_shim_states;
	vpcm_shim_states = state;
}

static struct vpcm_shim_state *vpcm_shim_take(struct dp *dp)
{
	struct vpcm_shim_state **link;

	for (link = &vpcm_shim_states; *link; link = &(*link)->next) {
		if ((*link)->inner == dp) {
			struct vpcm_shim_state *state = *link;
			*link = state->next;
			state->next = NULL;
			return state;
		}
	}

	return NULL;
}

static void vpcm_shim_log_create(struct vpcm_shim_state *state)
{
	long io_delay;
	long update_delay;
	long dp_requested;
	struct vpcm_runtime_prefix *runtime;
	unsigned qc_lapm;
	unsigned qc_index;
	unsigned char flags0;
	unsigned char flags1;
	unsigned char flags2;

	io_delay = modem_get_param(state->inner->modem, MDMPRM_IODELAY);
	update_delay = modem_get_param(state->inner->modem, MDMPRM_UPDATE_DELAY);
	dp_requested = modem_get_param(state->inner->modem, MDMPRM_DP_REQUESTED);
	runtime = (struct vpcm_runtime_prefix *)
		modem_get_param(state->inner->modem, MDMPRM_DPRUNTIME);
	qc_lapm = state->inner->modem->dsp_info.qc_lapm;
	qc_index = state->inner->modem->dsp_info.qc_index;
	flags0 = runtime ? runtime->flags0 : 0U;
	flags1 = runtime ? runtime->flags1 : 0U;
	flags2 = runtime ? runtime->flags2 : 0U;

	VPCMSHIM_DBG("create: path=%s stub=%s dp=%d caller=%d srate=%d frag=%d frag_ms=%d vpcmx_side=%s(%d) session=%d io_delay=%ld update_delay=%ld dp_requested=%ld qc_lapm=%u qc_index=%u rt=%02x/%02x/%02x rt_qc=%u\n",
		    state->use_stub ? "open-stub" : "blob",
		    vpcm_shim_stub_mode_name(state->stub_mode),
		    state->target_dp_id,
		    state->caller,
		    state->srate,
		    state->max_frag,
		    state->frag_ms,
		    vpcm_shim_side_name(state->vpcmx_side),
		    state->vpcmx_side,
		    state->session_type,
		    io_delay,
		    update_delay,
		    dp_requested,
		    qc_lapm,
		    qc_index,
		    flags0,
		    flags1,
		    flags2,
		    runtime ? runtime->qc_index : 0U);

	if (state->use_stub) {
		VPCMSHIM_DBG("create-stub: dp=%d connect_ms=%lu drop_ms=%lu bit_bridge=%d force_ec=%d loopback=%d log_ms=%lu\n",
			    state->target_dp_id,
			    state->stub_connect_samples
				    ? (state->stub_connect_samples * 1000UL) / (unsigned long)state->srate
				    : 0UL,
			    state->stub_drop_samples
				    ? (state->stub_drop_samples * 1000UL) / (unsigned long)state->srate
				    : 0UL,
			    state->stub_bit_bridge,
			    state->stub_force_ec,
			    state->stub_loopback,
			    state->stub_log_interval_samples
				    ? (state->stub_log_interval_samples * 1000UL) / (unsigned long)state->srate
				    : 0UL);
	}
}

static struct dp *vpcm_shim_create_stub(struct modem *m, enum DP_ID id,
					struct dp_operations *op)
{
	struct vpcm_stub_dp *stub;

	stub = calloc(1, sizeof(*stub));
	if (!stub)
		return NULL;

	stub->dp.id = id;
	stub->dp.modem = m;
	stub->dp.op = op;
	stub->dp.dp_data = stub;
	return &stub->dp;
}

static struct dp *vpcm_shim_create(struct modem *m, enum DP_ID id,
				   int caller, int srate, int max_frag,
				   struct dp_operations *op)
{
	struct dp_operations *real_ops;
	struct dp *inner;
	struct vpcm_shim_state *state;
	int frag_ms;
	enum vpcm_shim_stub_mode stub_mode;
	unsigned long connect_ms;
	unsigned long drop_ms;
	unsigned long log_ms;

	real_ops = vpcm_shim_real_ops(id);
	if (!real_ops)
		return NULL;

	stub_mode = vpcm_shim_get_stub_mode();
	if (!vpcm_shim_stub_allowed(id))
		stub_mode = VPCMSHIM_STUB_DISABLED;

	/*
	 * When digital side mode is active, seed dp_runtime->flags2 bit 4
	 * before the blob's vpcm_create runs. For V.92 (id == 0x5c) the
	 * blob preserves this bit; for V.90 it clears it, but the
	 * __wrap_VPCMXF_Create override ensures the VPcmFloModem is still
	 * created with side=1 regardless.
	 */
	if (vpcm_digital_side) {
		struct vpcm_runtime_prefix *runtime;

		runtime = (struct vpcm_runtime_prefix *)
			modem_get_param(m, MDMPRM_DPRUNTIME);
		if (runtime) {
			runtime->flags2 |= 0x10U;
			VPCMSHIM_DBG("create: seeded dp_runtime flags2 bit4 for digital side (flags2=0x%02x)\n",
				    runtime->flags2);
		}
	}

	if (stub_mode != VPCMSHIM_STUB_DISABLED)
		inner = vpcm_shim_create_stub(m, id, op);
	else if (real_ops->create)
		inner = real_ops->create(m, id, caller, srate, max_frag, real_ops);
	else
		inner = NULL;
	if (!inner)
		return NULL;

	state = calloc(1, sizeof(*state));
	if (!state) {
		if (stub_mode != VPCMSHIM_STUB_DISABLED)
			free(inner);
		else if (real_ops->delete)
			real_ops->delete(inner);
		return NULL;
	}

	frag_ms = 0;
	if (srate > 0)
		frag_ms = (max_frag * 1000) / srate;

	state->inner = inner;
	state->real_ops = real_ops;
	state->target_dp_id = id;
	state->caller = caller;
	state->srate = srate;
	state->max_frag = max_frag;
	state->frag_ms = frag_ms;
	state->vpcmx_side = vpcm_digital_side ? 1 : 0;
	state->session_type = vpcm_shim_session_type(id);
	state->last_ret = 0;
	state->use_stub = (stub_mode != VPCMSHIM_STUB_DISABLED);
	state->stub_mode = stub_mode;
	state->stub_bit_bridge = vpcm_shim_get_stub_bit_bridge();
	state->stub_force_ec = vpcm_shim_get_stub_force_ec();
	state->stub_loopback = vpcm_shim_get_stub_loopback();
	state->status = inner->status;

	connect_ms = vpcm_shim_parse_ulong_env("SLMODEMD_VPCM_STUB_CONNECT_MS", 500UL);
	drop_ms = vpcm_shim_parse_ulong_env("SLMODEMD_VPCM_STUB_DROP_MS", 0UL);
	log_ms = vpcm_shim_parse_ulong_env("SLMODEMD_VPCM_STUB_LOG_MS", VPCMSHIM_STUB_DEFAULT_LOG_MS);

	state->stub_connect_samples = vpcm_shim_millis_to_samples(srate, connect_ms);
	if (!state->stub_connect_samples && srate > 0)
		state->stub_connect_samples = (unsigned long)(srate / VPCMSHIM_STUB_CONNECT_DELAY_DIV);
	state->stub_drop_samples = vpcm_shim_millis_to_samples(srate, drop_ms);
	state->stub_log_interval_samples = vpcm_shim_millis_to_samples(srate, log_ms);
	if (!state->stub_log_interval_samples)
		state->stub_log_interval_samples = vpcm_shim_millis_to_samples(srate, VPCMSHIM_STUB_DEFAULT_LOG_MS);

	inner->op = op;
	vpcm_shim_add(state);
	vpcm_shim_log_create(state);
	return inner;
}

static int vpcm_shim_delete(struct dp *dp)
{
	struct vpcm_shim_state *state;
	int ret;

	state = vpcm_shim_take(dp);
	if (!state)
		return -1;

	VPCMSHIM_DBG("delete: path=%s stub=%s dp=%d last_ret=%d status=%u total_samples=%lu\n",
		    state->use_stub ? "open-stub" : "blob",
		    vpcm_shim_stub_mode_name(state->stub_mode),
		    state->target_dp_id, state->last_ret, state->status,
		    state->total_samples);

	if (state->use_stub) {
		free(dp);
		free(state);
		return 0;
	}

	if (!state->real_ops || !state->real_ops->delete) {
		free(state);
		return -1;
	}

	dp->op = state->real_ops;
	ret = state->real_ops->delete(dp);
	free(state);
	return ret;
}

static int vpcm_shim_process(struct dp *dp, void *in, void *out, int cnt)
{
	struct vpcm_shim_state *state;
	int ret;
	int nbytes;
	int bit_cnt;
	int i;
	int prev_ret;
	unsigned prev_status;
	unsigned long linked_ms;

	state = vpcm_shim_find(dp);
	if (!state)
		return -1;

	if (state->use_stub) {
		nbytes = cnt << MFMT_SHIFT(dp->modem->format);
		memset(out, 0, nbytes);
		state->total_samples += cnt;

		if (!state->stub_connected) {
			if (state->total_samples < state->stub_connect_samples) {
				state->last_ret = DPSTAT_OK;
				state->status = dp->status;
				return DPSTAT_OK;
			}

			if (state->stub_mode == VPCMSHIM_STUB_ERROR) {
				VPCMSHIM_DBG("process-stub: dp=%d returning error after %lu samples\n",
					    state->target_dp_id, state->total_samples);
				state->last_ret = DPSTAT_ERROR;
				state->status = dp->status;
				return DPSTAT_ERROR;
			}

			state->stub_connected = 1;
			state->linked_samples = 0;
			state->stub_next_log_samples = state->stub_log_interval_samples;
			VPCMSHIM_DBG("process-stub: dp=%d returning connect after %lu samples\n",
				    state->target_dp_id, state->total_samples);
			state->last_ret = DPSTAT_CONNECT;
			state->status = dp->status;
			return DPSTAT_CONNECT;
		}

		state->linked_samples += cnt;

		if (state->stub_force_ec && !state->stub_pack_promoted) {
			state->stub_pack_promoted = 1;
			dp->modem->cfg.ec = 1;
			VPCMSHIM_DBG("process-stub: dp=%d forcing PACK LINK with EC enabled\n",
				    state->target_dp_id);
			modem_update_status(dp->modem, STATUS_PACK_LINK);
		}

		if (state->stub_bit_bridge) {
			bit_cnt = cnt;
			if (bit_cnt > (int)sizeof(state->stub_bits))
				bit_cnt = sizeof(state->stub_bits);
			modem_get_bits(dp->modem, 1, state->stub_bits, bit_cnt);
			modem_put_bits(dp->modem, 1, state->stub_bits, bit_cnt);
			if (!state->stub_loopback && MFMT_IS_16BIT(dp->modem->format)) {
				s16 *samples = out;
				for (i = 0; i < bit_cnt; i++)
					samples[i] = state->stub_bits[i] & 0x1;
				for (; i < cnt; i++)
					samples[i] = 0;
			}
		}

		if (state->stub_loopback)
			memcpy(out, in, nbytes);

		if (state->stub_drop_samples &&
		    state->linked_samples >= state->stub_drop_samples) {
			VPCMSHIM_DBG("process-stub: dp=%d dropping link after %lu linked samples\n",
				    state->target_dp_id, state->linked_samples);
			state->last_ret = DPSTAT_ERROR;
			state->status = dp->status;
			return DPSTAT_ERROR;
		}

		if (state->stub_log_interval_samples &&
		    state->linked_samples >= state->stub_next_log_samples) {
			linked_ms = (state->linked_samples * 1000UL) / (unsigned long)state->srate;
			VPCMSHIM_DBG("process-stub: dp=%d linked_for=%lu ms samples=%lu loopback=%d\n",
				    state->target_dp_id,
				    linked_ms,
				    state->linked_samples,
				    state->stub_loopback);
			state->stub_next_log_samples += state->stub_log_interval_samples;
		}

		state->last_ret = DPSTAT_OK;
		state->status = dp->status;
		return DPSTAT_OK;
	}

	if (!state->real_ops || !state->real_ops->process)
		return -1;

	prev_ret = state->last_ret;
	prev_status = state->status;
	ret = state->real_ops->process(dp, in, out, cnt);
	state->total_samples += cnt;
	state->last_ret = ret;
	state->status = dp->status;
	if (ret != prev_ret || state->status != prev_status) {
		VPCMSHIM_DBG("process: path=blob dp=%d ret=%d status=%u samples=%lu\n",
			    state->target_dp_id,
			    ret,
			    state->status,
			    state->total_samples);
	}
	return ret;
}

static int vpcm_shim_hangup(struct dp *dp)
{
	struct vpcm_shim_state *state;

	state = vpcm_shim_find(dp);
	if (!state)
		return 0;
	if (state->use_stub || !state->real_ops || !state->real_ops->hangup)
		return 0;

	return state->real_ops->hangup(dp);
}

static struct dp_operations vpcm_shim_ops = {
	.name = "VPCM shim",
	.use_count = 0,
	.create = vpcm_shim_create,
	.delete = vpcm_shim_delete,
	.process = vpcm_shim_process,
	.hangup = vpcm_shim_hangup,
};

static int vpcm_shim_get_digital_side(void)
{
	const char *value = getenv("SLMODEMD_VPCM_DIGITAL_SIDE");

	if (!value || vpcm_shim_env_false(value))
		return 0;

	return 1;
}

int dp_vpcm_shim_init(void)
{
	real_v34_ops = modem_dp_get_ops(DP_V34);
	real_v90_ops = modem_dp_get_ops(DP_V90);
	real_v92_ops = modem_dp_get_ops(DP_V92);

	if (!real_v34_ops || !real_v90_ops || !real_v92_ops)
		return -1;

	vpcm_digital_side = vpcm_shim_get_digital_side();

	modem_dp_deregister(DP_V34, real_v34_ops);
	modem_dp_deregister(DP_V90, real_v90_ops);
	modem_dp_deregister(DP_V92, real_v92_ops);

	if (modem_dp_register(DP_V34, &vpcm_shim_ops) < 0)
		return -1;
	if (modem_dp_register(DP_V90, &vpcm_shim_ops) < 0)
		return -1;
	if (modem_dp_register(DP_V92, &vpcm_shim_ops) < 0)
		return -1;

	VPCMSHIM_DBG("installed shim around proprietary VPCM ops for DP_V34/DP_V90/DP_V92 (stub=%s digital_side=%s)\n",
		    vpcm_shim_stub_mode_name(vpcm_shim_get_stub_mode()),
		    vpcm_digital_side ? "yes" : "no");
	return 0;
}

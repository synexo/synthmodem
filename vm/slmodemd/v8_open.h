/*
 *
 *    v8_open.h - inferred open V.8 engine API.
 *
 */

#ifndef __V8_OPEN_H__
#define __V8_OPEN_H__

/*
 * Inferred from the proprietary v8_create() adapter:
 * the blob appears to pass a small configuration block into V8Create().
 */
struct v8_open_advertise_cfg {
	unsigned data;
	unsigned v92;
	unsigned v90;
	unsigned v34;
	unsigned v32;
	unsigned v22;
	unsigned quick_connect;
	unsigned lapm;
	unsigned access_call_cellular;
	unsigned access_answer_cellular;
	unsigned access_digital;
	unsigned pcm_analog;
	unsigned pcm_digital;
	unsigned pcm_v91;
};

struct v8_open_create_cfg {
	unsigned answer_mode;
	unsigned target_dp_id;
	unsigned reserved_04;
	unsigned signal_detect_timeout_secs;
	unsigned message_detect_timeout_secs;
	unsigned sample_rate;
	void *dp_runtime;
	struct v8_open_advertise_cfg advertise;
};

/*
 * The stub uses only the statuses that are already observed in real traces.
 * Additional statuses can be added later as the V8Process() enum is pinned down.
 */
#define V8_OPEN_STATUS_INIT            0
#define V8_OPEN_STATUS_ANS_SEND_ANSAM  1
#define V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CM 4
#define V8_OPEN_STATUS_ANS_TIMEOUT_WAITING_FOR_CJ 5
#define V8_OPEN_STATUS_ORG_SEND_CM     9
#define V8_OPEN_STATUS_ANS_SEND_JM     3
#define V8_OPEN_STATUS_ORG_JM_DETECTED 10
#define V8_OPEN_STATUS_ORG_WAITING_FOR_QCA1D 16
#define V8_OPEN_STATUS_OK             13

void *v8_open_create(const struct v8_open_create_cfg *cfg);
void  v8_open_delete(void *engine);
int   v8_open_process(void *engine, void *in, void *out, int cnt);
int   v8_open_answer_cm_timeout(const void *engine);
int   v8_open_answer_cj_timeout(const void *engine);
int   v8_open_answer_recommended_dp(const void *engine);

#endif /* __V8_OPEN_H__ */

/* 
 * Copyright (C) 2021 Aon plc
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA 
 */

#define _GNU_SOURCE
#include <unistd.h>
#include <stdbool.h>
#include <time.h>
#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <getopt.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include <sys/socket.h>
#include <sys/un.h>

#include <pjsua-lib/pjsua.h>

#include "slmodemd/modem.h"

#define SIGNATURE PJMEDIA_SIG_CLASS_PORT_AUD('D','M')
#define DMODEM_SELFTEST_ID_ENV "DMODEM_SELFTEST_ID"
#define DMODEM_SELFTEST_DIR_ENV "DMODEM_SELFTEST_DIR"
#define DMODEM_SELFTEST_DIR_DEFAULT "/tmp"

struct dmodem {
	pjmedia_port base;
	pj_timestamp timestamp;
	pj_sock_t sock;
};


static struct dmodem port;
static bool destroying = false;
static pj_pool_t *pool;

static int volume = 0;
static int sipsocket;
static pjsua_call_id pending_call_id = PJSUA_INVALID_ID;
static int sip_modem_hookstate =0;
static int local_selftest_mode = 0;
static volatile sig_atomic_t keep_running = 1;
static pjsua_conf_port_id modem_audio_id = PJSUA_INVALID_ID;
static pjsua_conf_port_id active_call_conf_slot = PJSUA_INVALID_ID;

#ifdef WITH_AUDIO
static pjsua_conf_port_id left_audio_id = PJSUA_INVALID_ID;
static pjsua_conf_port_id right_audio_id = PJSUA_INVALID_ID;
#endif

static void disconnect_call_media_slot(pjsua_conf_port_id call_slot)
{
	if (call_slot == PJSUA_INVALID_ID)
		return;
	if (modem_audio_id != PJSUA_INVALID_ID) {
		pjsua_conf_disconnect(call_slot, modem_audio_id);
		pjsua_conf_disconnect(modem_audio_id, call_slot);
	}
#ifdef WITH_AUDIO
	if (left_audio_id != PJSUA_INVALID_ID)
		pjsua_conf_disconnect(call_slot, left_audio_id);
#endif
}

static void selftest_sanitize_id(const char *src, char *dst, size_t dst_sz)
{
	size_t i;
	size_t j = 0;

	if (!dst_sz)
		return;

	for (i = 0; src && src[i] && j + 1 < dst_sz; ++i) {
		unsigned char ch = (unsigned char)src[i];
		if (isalnum(ch) || ch == '-' || ch == '_')
			dst[j++] = (char)ch;
		else
			dst[j++] = '_';
	}

	if (!j)
		dst[j++] = '0';

	dst[j] = '\0';
}

static int selftest_build_path(char *dst, size_t dst_sz,
			       const char *dir, const char *id)
{
	char safe_id[64];
	int n;

	if (!dir || !dir[0])
		dir = DMODEM_SELFTEST_DIR_DEFAULT;
	selftest_sanitize_id(id, safe_id, sizeof(safe_id));
	n = snprintf(dst, dst_sz, "%s/dmodem-selftest-%s.sock", dir, safe_id);
	if (n < 0 || (size_t)n >= dst_sz)
		return -1;
	return 0;
}

static int selftest_send_parent_info(int parent_sip_fd, const char *msg)
{
	struct socket_frame sf = { 0 };
	int ret;

	sf.type = SOCKET_FRAME_SIP_INFO;
	snprintf(sf.data.sip.info, sizeof(sf.data.sip.info), "%s", msg ? msg : "");
	ret = write(parent_sip_fd, &sf, sizeof(sf));
	if (ret != (int)sizeof(sf)) {
		perror("selftest: parent control write");
		return -1;
	}
	return 0;
}

static int selftest_kick_parent_audio(int parent_audio_fd)
{
	struct socket_frame sf = { 0 };
	int ret;

	sf.type = SOCKET_FRAME_AUDIO;
	ret = write(parent_audio_fd, &sf, sizeof(sf));
	if (ret != (int)sizeof(sf)) {
		perror("selftest: parent audio kick");
		return -1;
	}
	return 0;
}

static int selftest_send_peer_info(int local_fd,
				   const struct sockaddr_un *peer_addr,
				   socklen_t peer_len,
				   const char *msg)
{
	struct socket_frame sf = { 0 };
	int ret;

	if (!peer_addr || !peer_len)
		return -1;

	sf.type = SOCKET_FRAME_SIP_INFO;
	snprintf(sf.data.sip.info, sizeof(sf.data.sip.info), "%s", msg ? msg : "");
	ret = sendto(local_fd, &sf, sizeof(sf), 0,
		     (const struct sockaddr *)peer_addr, peer_len);
	if (ret != (int)sizeof(sf)) {
		perror("selftest: peer control send");
		return -1;
	}
	return 0;
}

static int selftest_set_peer(struct sockaddr_un *peer_addr,
			     socklen_t *peer_len,
			     const char *dir,
			     const char *id)
{
	char path[sizeof(peer_addr->sun_path)];
	size_t path_len;

	if (selftest_build_path(path, sizeof(path), dir, id) < 0)
		return -1;

	memset(peer_addr, 0, sizeof(*peer_addr));
	peer_addr->sun_family = AF_UNIX;
	snprintf(peer_addr->sun_path, sizeof(peer_addr->sun_path), "%s", path);
	path_len = strlen(peer_addr->sun_path);
	*peer_len = (socklen_t)(sizeof(peer_addr->sun_family) + path_len + 1);
	return 0;
}

static int run_local_selftest(const char *dialstr,
			      int parent_audio_fd,
			      int parent_sip_fd,
			      const char *self_id,
			      const char *self_dir)
{
	struct sockaddr_un local_addr;
	struct sockaddr_un peer_addr;
	socklen_t peer_len = 0;
	int local_fd = -1;
	int have_peer = 0;
	int call_active = 0;
	int incoming_pending = 0;
	char local_path[sizeof(local_addr.sun_path)];
	char self_id_safe[64];
	char pending_caller[64] = "";

	PJ_UNUSED_ARG(dialstr);

	local_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if (local_fd < 0) {
		perror("selftest: socket");
		return -1;
	}

	if (selftest_build_path(local_path, sizeof(local_path), self_dir, self_id) < 0) {
		fprintf(stderr, "selftest: invalid local socket path\n");
		close(local_fd);
		return -1;
	}

	memset(&local_addr, 0, sizeof(local_addr));
	local_addr.sun_family = AF_UNIX;
	snprintf(local_addr.sun_path, sizeof(local_addr.sun_path), "%s", local_path);

	unlink(local_addr.sun_path);
	if (bind(local_fd, (struct sockaddr *)&local_addr, sizeof(local_addr)) < 0) {
		perror("selftest: bind");
		close(local_fd);
		return -1;
	}

	selftest_sanitize_id(self_id, self_id_safe, sizeof(self_id_safe));
	printf("local selftest mode: id=%s socket=%s\n", self_id_safe, local_addr.sun_path);

	while (keep_running) {
		fd_set rset;
		int maxfd;
		int sret;

		FD_ZERO(&rset);
		FD_SET(parent_audio_fd, &rset);
		FD_SET(parent_sip_fd, &rset);
		FD_SET(local_fd, &rset);

		maxfd = parent_audio_fd;
		if (parent_sip_fd > maxfd)
			maxfd = parent_sip_fd;
		if (local_fd > maxfd)
			maxfd = local_fd;

		sret = select(maxfd + 1, &rset, NULL, NULL, NULL);
		if (sret < 0) {
			if (errno == EINTR)
				continue;
			perror("selftest: select");
			break;
		}

		if (FD_ISSET(parent_sip_fd, &rset)) {
			struct socket_frame sf = { 0 };
			int len = read(parent_sip_fd, &sf, sizeof(sf));
			char *packet;

			if (len <= 0)
				break;
			if (len != (int)sizeof(sf) || sf.type != SOCKET_FRAME_SIP_INFO)
				continue;

			sf.data.sip.info[sizeof(sf.data.sip.info) - 1] = '\0';
			packet = sf.data.sip.info;
			if (packet[0] != 'M')
				continue;

			packet++;
			if (packet[0] == 'D') {
				char msg[sizeof(sf.data.sip.info)];
				packet++;
				if (!packet[0])
					continue;
				if (selftest_set_peer(&peer_addr, &peer_len, self_dir, packet) < 0) {
					fprintf(stderr, "selftest: bad dial target `%s`\n", packet);
					continue;
				}
				snprintf(pending_caller, sizeof(pending_caller), "%s", packet);
				have_peer = 1;
				call_active = 0;
				incoming_pending = 0;
				snprintf(msg, sizeof(msg), "D%s", self_id_safe);
				selftest_send_peer_info(local_fd, &peer_addr, peer_len, msg);
			} else if (packet[0] == 'A') {
				if (incoming_pending && have_peer) {
					selftest_send_peer_info(local_fd, &peer_addr, peer_len, "A");
					call_active = 1;
					incoming_pending = 0;
					selftest_kick_parent_audio(parent_audio_fd);
				}
			} else if (packet[0] == 'H') {
				int hs = atoi(packet + 1);
				if (!hs) {
					if (have_peer)
						selftest_send_peer_info(local_fd, &peer_addr, peer_len, "H");
					call_active = 0;
					incoming_pending = 0;
				}
			}
		}

		if (FD_ISSET(parent_audio_fd, &rset)) {
			struct socket_frame sf = { 0 };
			int len = read(parent_audio_fd, &sf, sizeof(sf));
			int wr;

			if (len <= 0)
				break;
			if (len != (int)sizeof(sf))
				continue;
			if (!call_active || !have_peer)
				continue;

			wr = sendto(local_fd, &sf, sizeof(sf), 0,
				    (struct sockaddr *)&peer_addr, peer_len);
			if (wr != (int)sizeof(sf))
				perror("selftest: peer audio send");
		}

		if (FD_ISSET(local_fd, &rset)) {
			struct socket_frame sf = { 0 };
			struct sockaddr_un src_addr;
			socklen_t src_len = sizeof(src_addr);
			int len = recvfrom(local_fd, &sf, sizeof(sf), 0,
					   (struct sockaddr *)&src_addr, &src_len);

			if (len <= 0)
				continue;
			if (len != (int)sizeof(sf))
				continue;

			if (sf.type == SOCKET_FRAME_AUDIO) {
				if (!call_active)
					continue;
				if (write(parent_audio_fd, &sf, sizeof(sf)) != (int)sizeof(sf))
					perror("selftest: parent audio write");
			} else if (sf.type == SOCKET_FRAME_SIP_INFO) {
				char *packet = sf.data.sip.info;

				sf.data.sip.info[sizeof(sf.data.sip.info) - 1] = '\0';
				if (packet[0] == 'D') {
					packet++;
					memcpy(&peer_addr, &src_addr, sizeof(peer_addr));
					peer_len = src_len;
					have_peer = 1;
					call_active = 0;
					incoming_pending = 1;
					snprintf(pending_caller, sizeof(pending_caller), "%s", packet);
					printf("selftest: incoming call from %s\n",
					       pending_caller[0] ? pending_caller : "<unknown>");
					selftest_send_parent_info(parent_sip_fd, "SR");
				} else if (packet[0] == 'A') {
					memcpy(&peer_addr, &src_addr, sizeof(peer_addr));
					peer_len = src_len;
					have_peer = 1;
					call_active = 1;
					incoming_pending = 0;
					printf("selftest: call answered\n");
					selftest_kick_parent_audio(parent_audio_fd);
				} else if (packet[0] == 'H') {
					call_active = 0;
					incoming_pending = 0;
					selftest_send_parent_info(parent_sip_fd, "SH");
				}
			}
		}
	}

	if (call_active && have_peer)
		selftest_send_peer_info(local_fd, &peer_addr, peer_len, "H");

	close(local_fd);
	unlink(local_addr.sun_path);
	return 0;
}

static void error_exit(const char *title, pj_status_t status) {
	pjsua_perror(__FILE__, title, status);
	if (!destroying) {
		destroying = true;
		pjsua_destroy();
		exit(1);
	}
}

static pj_status_t dmodem_put_frame(pjmedia_port *this_port, pjmedia_frame *frame) {
	struct dmodem *sm = (struct dmodem *)this_port;
	struct socket_frame socket_frame = { 0 };
	int len;

	socket_frame.type = SOCKET_FRAME_AUDIO;

	if (frame->type == PJMEDIA_FRAME_TYPE_AUDIO &&
	    frame->size == sizeof(socket_frame.data.audio.buf)) {
		memcpy(socket_frame.data.audio.buf, frame->buf, frame->size);
	}
	/* else: zero-filled silence — keeps modem DSP clock running */

	if ((len=write(sm->sock, &socket_frame, sizeof(socket_frame))) != sizeof(socket_frame)) {
		printf("dmodem:error writing audio frame\n");
	}

	return PJ_SUCCESS;
}

static pj_status_t dmodem_get_frame(pjmedia_port *this_port, pjmedia_frame *frame) {
	struct dmodem *sm = (struct dmodem *)this_port;
	struct socket_frame socket_frame = { 0 };

	frame->size = PJMEDIA_PIA_MAX_FSZ(&this_port->info);
	if (frame->size != SIP_FRAMESIZE * 2) {
		fprintf(stderr,"incompatible frame size: %lu, expected: %d!\n", frame->size, SIP_FRAMESIZE * 2);
		
		//exit(EXIT_FAILURE);
	}

	while(1) {
		int len;
		if ((len=read(sm->sock, &socket_frame, sizeof(socket_frame))) != sizeof(socket_frame)) {
			//error_exit("error reading frame",0);
			printf("dmodem_get_frame: error reading frame\n");
		}

		switch(socket_frame.type) {
			case SOCKET_FRAME_AUDIO:
				//printf("dmodem_get_frame: audio frame recieved\n");
				len = frame->size;
				memcpy(frame->buf, socket_frame.data.audio.buf, len);
				frame->timestamp.u64 = sm->timestamp.u64;
				frame->type = PJMEDIA_FRAME_TYPE_AUDIO;
				sm->timestamp.u64 += PJMEDIA_PIA_PTIME(&this_port->info);
				return PJ_SUCCESS;
				break;
			case SOCKET_FRAME_VOLUME:
				printf("dmodem_get_frame: volume frame recieved\n");
				if (socket_frame.data.volume.value != volume) {
					float level = 1.0;
					if (socket_frame.data.volume.value >=0 && socket_frame.data.volume.value <= 3) {
						level = socket_frame.data.volume.value / 3.0;
					}
#ifdef WITH_AUDIO
					if (left_audio_id != PJSUA_INVALID_ID)
						pjsua_conf_adjust_tx_level(left_audio_id, level);
					if (right_audio_id != PJSUA_INVALID_ID)
						pjsua_conf_adjust_tx_level(right_audio_id, level);
#endif
					volume = socket_frame.data.volume.value;
					printf("dmodem_get_frame: Volume: %d -> %f\n", volume, level);
				}
				break;
			default:
				//error_exit("Invalid frame received!", 0);
				printf("dmodem_get_frame: invalid frame\n");
		}
	}

	exit(1);
	return PJSIP_EINVALIDMSG;
}

static pj_status_t dmodem_on_destroy(pjmedia_port *this_port) {
	printf("destroy\n");
	exit(-1);
}

/* Callback called by the library when call's state has changed */
static void on_call_state(pjsua_call_id call_id, pjsip_event *e) {
	printf("on_call_state: callback\n");
	pjsua_call_info ci;

	PJ_UNUSED_ARG(e);

	pjsua_call_get_info(call_id, &ci);
	PJ_LOG(3,(__FILE__, "Call %d state=%.*s", call_id,
				(int)ci.state_text.slen,
				ci.state_text.ptr));

	if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
		if (active_call_conf_slot == ci.conf_slot) {
			disconnect_call_media_slot(active_call_conf_slot);
			active_call_conf_slot = PJSUA_INVALID_ID;
		}
		/* Notify slmodemd of remote hangup */
		struct socket_frame sf = { 0 };
		sf.type = SOCKET_FRAME_SIP_INFO;
		snprintf(sf.data.sip.info, sizeof(sf.data.sip.info), "SH");
		int ret = write(sipsocket, &sf, sizeof(sf));
		if (ret != sizeof(sf)) {
			perror("on_call_state: write SH fail");
		}
		printf("on_call_state: sent SH (hangup) to slmodemd\n");
		pending_call_id = PJSUA_INVALID_ID;
	}

	//if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
	//	close(port.sock);
	//	if (!destroying) {
	//		destroying = true;
	//		pjsua_destroy();
	//		exit(0);
	//	}
	//}
}




/* Callback called by the library when call's media state has changed */
static void on_call_media_state(pjsua_call_id call_id) {
	printf("on_call_media_state: callback\n");
	pjmedia_port *sc, *left, *right;
	pjmedia_aud_dev_index devidx = -1;
	pjsua_call_info ci;
	struct socket_frame socket_frame = { 0 };
	
	pjsua_call_get_info(call_id, &ci);

//	printf("media_status %d media_cnt %d ci.conf_slot %d aud.conf_slot %d\n",ci.media_status,ci.media_cnt,ci.conf_slot,ci.media[0].stream.aud.conf_slot);
	if (ci.media_status != PJSUA_CALL_MEDIA_ACTIVE ||
	    ci.conf_slot == PJSUA_INVALID_ID)
		return;

	if (modem_audio_id == PJSUA_INVALID_ID) {
		if (pjsua_conf_add_port(pool, &port.base, &modem_audio_id) != PJ_SUCCESS)
			error_exit("can't add modem port",0);

#ifdef WITH_AUDIO
		if (pjmedia_splitcomb_create(pool, SIP_RATE, 2, SIP_FRAMESIZE, 16, 0, &sc) != PJ_SUCCESS)
			error_exit("can't create splitter/combiner",0);

		// left: SIP call -> monitor/playback.
		if (pjmedia_splitcomb_create_rev_channel(pool, sc, 0, 0, &left) != PJ_SUCCESS)
			error_exit("can't create left channel",0);
		if (pjsua_conf_add_port(pool, left, &left_audio_id) != PJ_SUCCESS)
			error_exit("can't add left port",0);
		pjsua_conf_adjust_tx_level(left_audio_id, 0.0);

		// right: d-modem -> monitor/playback.
		if (pjmedia_splitcomb_create_rev_channel(pool, sc, 1, 0, &right) != PJ_SUCCESS)
			error_exit("can't create right channel",0);
		if (pjsua_conf_add_port(pool, right, &right_audio_id) != PJ_SUCCESS)
			error_exit("can't add right port",0);
		if (pjsua_conf_connect(modem_audio_id, right_audio_id) != PJ_SUCCESS)
			error_exit("can't connect right port",0);
		pjsua_conf_adjust_tx_level(right_audio_id, 0.0);

		if (pjmedia_aud_dev_lookup("ALSA", "default", &devidx) != PJ_SUCCESS)
			devidx = -1;

		{
			pjmedia_snd_port *audiodev;
			if (pjmedia_snd_port_create_player(pool, devidx, SIP_RATE, 2, SIP_FRAMESIZE, 16, 0, &audiodev) == PJ_SUCCESS) {
				if (pjmedia_snd_port_connect(audiodev, sc) != PJ_SUCCESS)
					error_exit("can't connect audio device port",0);
			} else {
				pjsua_perror(__FILE__,"can't create audio device port",PJ_SUCCESS);
			}
		}
#endif
	}

	if (active_call_conf_slot != PJSUA_INVALID_ID &&
	    active_call_conf_slot != ci.conf_slot)
		disconnect_call_media_slot(active_call_conf_slot);

	/* Ensure reconnect works after call-id/slot churn. */
	disconnect_call_media_slot(ci.conf_slot);
	if (pjsua_conf_connect(ci.conf_slot, modem_audio_id) != PJ_SUCCESS)
		error_exit("can't connect modem port (out)",0);
	if (pjsua_conf_connect(modem_audio_id, ci.conf_slot) != PJ_SUCCESS)
		error_exit("can't connect modem port (in)",0);
#ifdef WITH_AUDIO
	if (left_audio_id != PJSUA_INVALID_ID) {
		if (pjsua_conf_connect(ci.conf_slot, left_audio_id) != PJ_SUCCESS)
			error_exit("can't connect left port",0);
		pjsua_conf_adjust_tx_level(left_audio_id, 0.0);
	}
#endif
	active_call_conf_slot = ci.conf_slot;
	printf("on_call_media_state: bridge call=%d conf_slot=%d modem_port=%d\n",
	       call_id, ci.conf_slot, modem_audio_id);

	// Kick off audio for each newly active call.
	printf("Kicking off audio!\n");
	socket_frame.type = SOCKET_FRAME_AUDIO;
	write(port.sock, &socket_frame, sizeof(socket_frame));
}

/* Callback called by the library upon receiving incoming call */
static void on_incoming_call(pjsua_acc_id acc_id, pjsua_call_id call_id,
                             pjsip_rx_data *rdata)
{
	printf("on_incoming_call: callback\n");
    pjsua_call_info inci;

	struct socket_frame sip_socket_frame = { 0 };
    PJ_UNUSED_ARG(acc_id);
    PJ_UNUSED_ARG(rdata);
	int ret;
    pjsua_call_get_info(call_id, &inci);
	printf("RING!\n");
	printf("Incoming call from %.*s\n",(int)inci.remote_info.slen,
                         inci.remote_info.ptr);

    PJ_LOG(3,(__FILE__, "Incoming call from %.*s!!",
                         (int)inci.remote_info.slen,
                         inci.remote_info.ptr));
	sip_socket_frame.type = SOCKET_FRAME_SIP_INFO;
	printf("return_data_to_modem: write to socket\n");
	snprintf(sip_socket_frame.data.sip.info,256,"SR");
	ret = write(sipsocket,&sip_socket_frame, sizeof(sip_socket_frame));
	printf("sip socket write %i\n",ret);
	if (ret != sizeof(sip_socket_frame)) {
			perror("return_data_to_child: write fail\n");
		exit(EXIT_FAILURE);
	}
	
	/* Store call_id; main loop will answer when ATA/MA is received */
	pending_call_id = call_id;
}



static void sig_handler(int sig, siginfo_t *si, void *x) {
	PJ_UNUSED_ARG(si);
	PJ_UNUSED_ARG(x);
	switch(sig) {
		case SIGTERM:
			keep_running = 0;
			if (local_selftest_mode)
				return;
			pjsua_call_hangup_all();
			exit(EXIT_SUCCESS);
			break;
		default:
			break;
	}
}


int main(int argc, char *argv[]) {
	pjsua_acc_id acc_id;
	pjsua_transport_id transport;
	pj_status_t status;
	struct socket_frame sip_socket_frame = { 0 };

	char *sip_domain = NULL;
	char *sip_user = NULL;
	char *sip_pass = NULL;
	int direct_call = 1;

	static struct option long_options[] = {
		{"sip-server",   required_argument, 0, 's'},
		{"sip-user",     required_argument, 0, 'u'},
		{"sip-password", required_argument, 0, 'p'},
		{0, 0, 0, 0}
	};

	int opt;
	while ((opt = getopt_long(argc, argv, "", long_options, NULL)) != -1) {
		switch (opt) {
			case 's': sip_domain = optarg; break;
			case 'u': sip_user   = optarg; break;
			case 'p': sip_pass   = optarg; break;
			default:
				fprintf(stderr, "Usage: %s [--sip-server SERVER] [--sip-user USER] [--sip-password PASS] dialstr audio_sock sip_sock\n", argv[0]);
				return -1;
		}
	}

	if (argc - optind != 3) {
		fprintf(stderr, "Usage: %s [--sip-server SERVER] [--sip-user USER] [--sip-password PASS] dialstr audio_sock sip_sock\n", argv[0]);
		return -1;
	}

	char *dialstr = argv[optind];
	int audiosocket = atoi(argv[optind + 1]);
	sipsocket       = atoi(argv[optind + 2]);
	{
		const char *selftest_id = getenv(DMODEM_SELFTEST_ID_ENV);
		const char *selftest_dir = getenv(DMODEM_SELFTEST_DIR_ENV);
		struct sigaction sa = { 0 };

		if (!selftest_dir || !selftest_dir[0])
			selftest_dir = DMODEM_SELFTEST_DIR_DEFAULT;

		printf("dmodem begin...\n");
		printf("args: dialstr=%s audio_sock=%d sip_sock=%d\n", dialstr, audiosocket, sipsocket);

		signal(SIGPIPE,SIG_IGN);
		sa.sa_flags = SA_SIGINFO;
		sigemptyset(&sa.sa_mask);
		sa.sa_sigaction = sig_handler;
		sigaction(SIGTERM, &sa, NULL);

		if (selftest_id && selftest_id[0]) {
			local_selftest_mode = 1;
			return run_local_selftest(dialstr, audiosocket, sipsocket,
						 selftest_id, selftest_dir);
		}
	}

	if (sip_user && sip_domain) {
		if (!sip_pass) {
			fprintf(stderr, "SIP password required when SIP user/server are specified\n");
			exit(EXIT_FAILURE);
		}
		direct_call = 0;
	} else {
		printf("No SIP credentials, continuing with direct SIP calls.\n");
		printf("Use `ATDTendpoint@sip.domain' for calls\n");
	}

	printf("dmodem starting..\n");

	if (strchr(dialstr, '@')) {
		printf("Found '@' in %s, continuing with direct call\n", dialstr);
		direct_call = 1;
	} else if (direct_call == 1) {
		fprintf(stderr, "No SIP credentials and not a direct call: %s\n", dialstr);
		exit(EXIT_FAILURE);
	}

	status = pjsua_create();
	if (status != PJ_SUCCESS) error_exit("Error in pjsua_create()", status);

	/* Init pjsua */
	{
		pjsua_config cfg;
		pjsua_logging_config log_cfg;
		pjsua_media_config med_cfg;

		pjsua_config_default(&cfg);
		cfg.cb.on_call_media_state = &on_call_media_state;
		cfg.cb.on_call_state = &on_call_state;
		cfg.cb.on_incoming_call = &on_incoming_call;
		pjsua_logging_config_default(&log_cfg);
		log_cfg.console_level = 4;

		pjsua_media_config_default(&med_cfg);
		med_cfg.clock_rate = SIP_RATE;
		med_cfg.quality = 10;
		med_cfg.no_vad = true;
		med_cfg.ec_tail_len = 0;
		med_cfg.snd_use_sw_clock = true;
		/* Fixed jitter buffer for modem traffic - adaptive mode
		   drops/inserts frames which corrupts modem data.
		   min_pre == max_pre == init forces fixed (non-adaptive) mode;
		   0 means "use default" which enables adaptation. */
		med_cfg.jb_max = 500;
		med_cfg.jb_min_pre = 40;
		med_cfg.jb_max_pre = 40;
		med_cfg.jb_init = 40;
		med_cfg.audio_frame_ptime = 20;
		med_cfg.has_ioqueue = true;
		med_cfg.thread_cnt = 1;

		status = pjsua_init(&cfg, &log_cfg, &med_cfg);
		if (status != PJ_SUCCESS) error_exit("Error in pjsua_init()", status);
	}

	pjsua_set_ec(0,0); // maybe?
	pjsua_set_null_snd_dev();
	
	/* g711 only */
	pjsua_codec_info codecs[32];
	unsigned count = sizeof(codecs)/sizeof(*codecs);
	pjsua_enum_codecs(codecs,&count);
	for (int i=0; i<count; i++) {
		int pri = 0;
		if (pj_strcmp2(&codecs[i].codec_id,"PCMU/8000/1") == 0) {
			pri = 1;
		} else if (pj_strcmp2(&codecs[i].codec_id,"PCMA/8000/1") == 0) {
			pri = 1;
		}
		pjsua_codec_set_priority(&codecs[i].codec_id, pri);
	}

	/* Disable PLC on G.711 codecs - PLC generates fake audio that
	   corrupts modem signals during packet loss */
	{
		pjmedia_codec_param codec_param;
		pj_str_t pcmu_id = pj_str("PCMU/8000/1");
		pj_str_t pcma_id = pj_str("PCMA/8000/1");
		if (pjsua_codec_get_param(&pcmu_id, &codec_param) == PJ_SUCCESS) {
			codec_param.setting.plc = 0;
			codec_param.setting.vad = 0;
			pjsua_codec_set_param(&pcmu_id, &codec_param);
		}
		if (pjsua_codec_get_param(&pcma_id, &codec_param) == PJ_SUCCESS) {
			codec_param.setting.plc = 0;
			codec_param.setting.vad = 0;
			pjsua_codec_set_param(&pcma_id, &codec_param);
		}
	}

	/* Add UDP transport. */
	{
		pjsua_transport_config cfg;

		pjsua_transport_config_default(&cfg);
		cfg.port = 0;
		status = pjsua_transport_create(PJSIP_TRANSPORT_UDP, &cfg, &transport);
		if (status != PJ_SUCCESS) error_exit("Error creating transport", status);
	}

	pj_caching_pool cp;
	pj_caching_pool_init(&cp, NULL, 1024*1024);
	pool = pj_pool_create(&cp.factory, "pool1", 4000, 4000, NULL);

	pj_str_t name = pj_str("dmodem");
	
	memset(&port,0,sizeof(port));
	port.sock = audiosocket; // inherited from parent
	pjmedia_port_info_init(&port.base.info, &name, SIGNATURE, SIP_RATE, 1, 16, SIP_FRAMESIZE);
	port.base.put_frame = dmodem_put_frame;
	port.base.get_frame = dmodem_get_frame;
	port.base.on_destroy = dmodem_on_destroy;


	char buf[1024] = { 0 };
	/* Initialization is done, now start pjsua */
	status = pjsua_start();
	if (status != PJ_SUCCESS) error_exit("Error starting pjsua", status);



	if (!direct_call) {
		pjsua_acc_config cfg;
		pjsua_acc_config_default(&cfg);
		snprintf(buf,sizeof(buf),"sip:%s@%s",sip_user,sip_domain);
		pj_strdup2(pool,&cfg.id,buf);
		snprintf(buf,sizeof(buf),"sip:%s",sip_domain);
		pj_strdup2(pool,&cfg.reg_uri,buf);
		cfg.register_on_acc_add = true;
		cfg.rtp_cfg.port = 0;
		cfg.cred_count = 1;
		cfg.cred_info[0].realm = pj_str("*");
		cfg.cred_info[0].scheme = pj_str("digest");
		cfg.cred_info[0].username = pj_str(sip_user);
		cfg.cred_info[0].data_type = PJSIP_CRED_DATA_PLAIN_PASSWD;
		cfg.cred_info[0].data = pj_str(sip_pass);

		status = pjsua_acc_add(&cfg, PJ_TRUE, &acc_id);
		if (status != PJ_SUCCESS) error_exit("Error adding account", status);
	} else {
		pjsua_acc_config cfg;
		status = pjsua_acc_add_local(transport, PJ_TRUE, &acc_id);
		if (status != PJ_SUCCESS) error_exit("Error adding account", status);
		if ((status = pjsua_acc_get_config(acc_id, pool, &cfg)) != PJ_SUCCESS)
			error_exit("Error getting local account config", status);
		cfg.rtp_cfg.port = 0;
		if ((status = pjsua_acc_modify(acc_id, &cfg)) != PJ_SUCCESS)
			error_exit("Error modifying local account config", status);
	}

	char *dial = dialstr;

	
	//printf("dial = `%s` \n",dial);
    //printf("dialstr = `%s` \n",dialstr);
	if (!dial[0])
	{
		printf("Empty Dial String. waiting for command\n");
	}

	printf("Dialer PID: %d\n", getpid());

	char sipcid[32] = "";
	struct timeval stmo;
	fd_set srset,seset;
	int sret;

	stmo.tv_sec = 0;
	stmo.tv_usec = 2000;

	while(1) {
		//printf("loop?\n");

		FD_ZERO(&srset);
		FD_ZERO(&seset);
		FD_SET(sipsocket,&srset);
		FD_SET(sipsocket,&seset);
		sret = select(sipsocket + 1,&srset,NULL,&seset,&stmo);

        if (sret < 0) {
			printf("dmm: sret < 0/s");
			if (errno == EINTR)
				continue;
            printf("sselect: %s\n",strerror(errno));
                return sret;
                }				

		if (sret == 0) continue;

		int len;
		if ((len=read(sipsocket, &sip_socket_frame, sizeof(sip_socket_frame))) != sizeof(sip_socket_frame)) {
			//error_exit("error reading frame",0);
			
			printf("dmodem_main: error reading frame %i\n",len);
		}
		char *packet;
		packet = sip_socket_frame.data.sip.info;
		printf("dmm:packet:%s\n",sip_socket_frame.data.sip.info);
		switch(sip_socket_frame.type) {
			case SOCKET_FRAME_SIP_INFO:
				printf("dmodem_main: sip info frame recieved\n");
				//printf("dmodem_main: still here? \n");

				printf("dmm:packet:%s\n",packet);
				if (strncmp(packet,"M",1) == 0){
					packet++;

					printf("dmm:packet:M:%s\n",packet);
					if (strncmp(packet,"A",1) == 0){
						if (pending_call_id != PJSUA_INVALID_ID) {
							pjsua_call_answer(pending_call_id, 200, NULL, NULL);
							pending_call_id = PJSUA_INVALID_ID;
						}
					}
					if (strncmp(packet,"H",1) == 0){
						packet++;
						printf("dmm:packet:H:%s\n",packet);
						
						int hs;
						hs = atoi(packet);
						// answer or disconnect call based on hook state
						printf("dmodem_main: current hookstate: %i\n",sip_modem_hookstate);
						if (hs != sip_modem_hookstate) {
							if (!hs) {
								printf("hanging up calls due to hookstate \n");
								pjsua_call_hangup_all();
								}
						sip_modem_hookstate = hs;
						printf("dmodem_main: changed hookstate: %d\n",sip_modem_hookstate);						
						}
					}				
					if (strncmp(packet,"D",1) == 0){
						packet++;
						printf("dmm:packet:H:%s\n",packet);
						printf("dmodem_main: new cid data\n");
						printf("dmodem_main: old dialstring: %s \n",sipcid);
					
						sprintf(sipcid,"%s",packet);
						sprintf(buf,"sip:%s@%s",sipcid,sip_domain);
						pj_str_t sipuri = pj_str(buf);
						printf("dmodem_main: new dialstring: %s \n",sipcid);
						printf("dmodem_main: sip dialstring: %s \n", buf);
					
						//check cid
						if (sipcid[0]){
						printf("dmodem_main: dialling..\n");
						//make call
						pjsua_call_id callid;
						//update modem of call state
						sprintf(sip_socket_frame.data.sip.info,"CALLING");
						if ((len=write(sipsocket, &sip_socket_frame, sizeof(sip_socket_frame))) != sizeof(sip_socket_frame)) {
						printf("dmodem_main: error writing frame %i\n",len);}	
						//call pjsua
						status = pjsua_call_make_call(acc_id, &sipuri, 0, NULL, NULL, &callid);
						if (status != PJ_SUCCESS) error_exit("Error making call", status);
						}
						printf("dmodem_main: cid loop complete\n");
						
					}

					printf("dmodem_main: finished commands\n");
				}
				break;
		default:
			printf("dmodem_main: invalid frame\n");
			break;
		}
	}

}	

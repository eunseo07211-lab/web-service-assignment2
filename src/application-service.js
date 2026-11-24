import { AppError, missing, forbidden, invalidState } from './errors.js';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function transaction(repo, callback) {
  const maxRetries = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      repo.db.exec('BEGIN IMMEDIATE');
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      const isBusy =
        err?.code === 'SQLITE_BUSY' ||
        err?.code === 'SQLITE_LOCKED' ||
        msg.includes('busy') ||
        msg.includes('locked');
      if (!isBusy || attempt >= maxRetries) {
        throw err;
      }
      sleepSync(15);
    }
  }

  try {
    const result = callback(repo);
    repo.db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      repo.db.exec('ROLLBACK');
    } catch (_) {
      // 이미 롤백되었거나 트랜잭션이 닫힌 경우 무시
    }
    throw err;
  }
}

// TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
// 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
// ---> 학생 권한 및 행사 존재 여부, 중복 신청 확인 후 PENDING 상태 저장 + APPLY 이력 기록

export function createApplicationService(repo) {
  return {
    apply(actor, eventId) {
      // 1. 학생 역할을 검사
      if (actor.role !== 'STUDENT') {
        throw forbidden('학생 회원만 신청할 수 있습니다.');
      }

      // 2. 행사 존재 여부 검사
      const event = repo.event(eventId);
      if (!event) {
        throw missing('행사');
      }

      // 3. 중복 신청을 했는지 검사 (repo.existing 활용, 취소 및 승인취소 이력이 있는 경우도 중복으로 간주하여 차단)
      const existing = repo.existing(eventId, actor.id);
      if (existing) {
        throw new AppError(409, 'ALREADY_APPLIED', '이미 해당 행사 신청 내역이 존재합니다.');
      }

      // 4. 트랜잭션 처리 (PENDING 저장 + APPLY 이력)
      return transaction(repo, (txRepo) => {
        const app = txRepo.insert(eventId, actor.id);
        txRepo.addHistory({
          applicationId: app.id,
          actorId: actor.id,
          action: 'APPLY',
          fromStatus: null,
          toStatus: 'PENDING'
        });
        return app;
      });
    },

    cancel(actor, applicationId) {
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
      // ---> 본인의 PENDING 신청건을 CANCELLED로 변경하고 CANCEL 이력 기록

      // 1. 신청 내역 존재 여부 검사
      const app = repo.application(applicationId);
      if (!app) {
        throw missing('신청 내역을 찾을 수 없습니다.');
      }

      // 2. 본인 신청 여부 검사
      if (app.userId !== actor.id) {
        throw forbidden('본인의 신청 내역만 취소할 수 있습니다.');
      }

      // 3. PENDING 상태 검사
      if (app.status !== 'PENDING') {
        throw invalidState('대기(PENDING) 상태인 신청만 취소할 수 있습니다.');
      }

      // 4. 트랜잭션 처리 (CANCELLED 변경 + CANCEL 이력), 대기 취소 시에는 정원 자리가 나지 않으므로 자동 승급을 수행하지 않음
      return transaction(repo, (txRepo) => {
        const updated = txRepo.setStatus(applicationId, 'CANCELLED');
        txRepo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'CANCEL',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED'
        });
        return updated;
      });
    },

    approve(actor, applicationId) {
      return transaction(repo, (txRepo) => {
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
      // ---> 담당 운영자 권한, PENDING 상태, 정원 초과 여부 검사 후 APPROVED 승인 처리

      // 1. 신청 내역 존재 여부 검사
      const app = txRepo.application(applicationId);
      if (!app) {
        throw missing('신청 내역을 찾을 수 없습니다.');
      }

      // 2. 행사 존재 및 담당 운영자 권한 검사
      const event = txRepo.event(app.eventId);
      if (!event) {
        throw missing('행사');
      }
      if (actor.role !== 'MANAGER' || event.managerId !== actor.id) {
        throw forbidden('해당 행사의 담당 운영자만 승인할 수 있습니다.');
      } 

      // 3. PENDING 상태 검사
      if (app.status !== 'PENDING') {
        throw invalidState('대기(PENDING) 상태인 신청만 승인할 수 있습니다.');
      }

      // 4. 정원 검사(현재 승인된 인원수(approvedCount)가 행사 정원을 넘었는지 확인)
      const approvedCount = txRepo.approvedCount(app.eventId);
      if (approvedCount >= event.capacity) {
        throw new AppError(409, 'CAPACITY_FULL', '행사 정원이 초과되어 승인할 수 없습니다.');
      }

      // 5. 트랜잭션 처리 (APPROVED 변경 + APPROVE 이력)
        const updated = txRepo.setStatus(applicationId, 'APPROVED');
        txRepo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'APPROVE',
          fromStatus: 'PENDING',
          toStatus: 'APPROVED'
        });
        return updated;
      });
    },

    revoke(actor, applicationId, reason) {
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
      // ---> 승인된 신청을 REVOKED 처리하고, FIFO 순서에 따라 대기자 1명을 자동 승급(AUTO_APPROVE)

      // 1. 신청 내역 존재 여부 검사
      const app = repo.application(applicationId);
      if (!app) {
        throw missing('신청 내역을 찾을 수 없습니다.');
      }
      
      // 2. 담당 운영자 권한 검사
      const event = repo.event(app.eventId);
      if (!event) {
        throw missing('행사');
      }
      if (actor.role !== 'MANAGER' || event.managerId !== actor.id) {
        throw forbidden('해당 행사의 담당 운영자만 승인 취소할 수 있습니다.');
      }

      // 3. APPROVED 상태 검사
      if (app.status !== 'APPROVED') {
        throw invalidState('승인(APPROVED) 상태인 신청만 승인 취소할 수 있습니다.');
      }

      // 4. 사유 공백을 제거 하고 승인 취소 사유 검사 (5~200자 길이)
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < 5 || trimmedReason.length > 200) {
        throw invalidState('승인 취소 사유는 5~200자여야 합니다.');
      }

      // 5. 트랜잭션 처리 (승인 취소 + REVOKE 이력 + FIFO 자동 승급 + AUTO_APPROVE 이력)
      return transaction(repo, (txRepo) => {
        const revokedApp = txRepo.setStatus(applicationId, 'REVOKED');

        const revokeHistoryId = txRepo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: 'APPROVED',
          toStatus: 'REVOKED',
          reason: trimmedReason
        });

        let promotedApp = null;

        // 신청일시(created_at) 오름차순, ID 오름차순 기준으로 대기 중인 첫 번째 신청자 추출 (FIFO)
        const allApps = txRepo.forEvent(app.eventId);
        const pendingApps = allApps
          .filter(item => item.status === 'PENDING')
          .sort((a, b) => {
            if (a.createdAt < b.createdAt) return -1;
            if (a.createdAt > b.createdAt) return 1;
            return a.id - b.id;
          });

        if (pendingApps.length > 0) {
          const target = pendingApps[0];
          promotedApp = txRepo.setStatus(target.id, 'APPROVED');
          
        // AUTO_APPROVE 이력 생성 및 원인 REVOKE 이력 ID 연결 (causeHistoryId)
        txRepo.addHistory({
            applicationId: target.id,
            actorId: actor.id,
            action: 'AUTO_APPROVE',
            fromStatus: 'PENDING',
            toStatus: 'APPROVED',
            causeHistoryId: revokeHistoryId
          });
        }

        return {
          revoked: revokedApp,
          promoted: promotedApp
        };
      });
    }
  };
}
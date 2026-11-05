const selfSilence =
  /^\s*[（(]?(?:(?:(?:这条|这句|这次|这个问题)[^。！？\n]{0,100}?)?我(?:这边)?(?:先|就|暂时)?(?:不插话|不参与|保持沉默|不接|不回应|不说话)|保持沉默)(?:[，,；;](?:等|待|后续|需要时|由|让|交给)[^。！？\n]{0,120})?[。.!！?？]?[）)]?\s*$/;
const noReply =
  /^\s*[（(]?(?:无需|无须|不需要|不用|不必)(?:我(?:再|继续)?|再|继续)?(?:回复|回应|插话|发言)(?:\s*[。.!！?？]?[）)]?\s*$|\s*[—–－:：，,；;])/u;
const internalReason =
  /(?:没有|暂无|并无)[^。！？\n]{0,40}(?:需要我|我需要|我要)[^。！？\n]{0,20}(?:处理|回应|回复|参与)|我(?:这边)?(?:先|就|暂时)?(?:不插话|不参与|保持沉默|不回应)/u;

/** A fallback for explicit self-silence narration, not a general relevance classifier. */
export function isSilenceNarration(content: string) {
  if (selfSilence.test(content)) return true;
  if (/(?:不过|但是|但我|另有|另外|补充|发现|纠正|错误|失败|阻塞|风险)/u.test(content))
    return false;
  return noReply.test(content) && internalReason.test(content);
}

BEGIN { FS="\t"; OFS="|" }
{
  op=$1; id=$2
  if (op == "OPEN") {
    owner[id]=$3; score[id]=$4+0; state[id]="OPEN"; events[id]=1; cases[id]=1
  } else if (op == "ADD") {
    score[id]+=$3; events[id]++
  } else if (op == "OWNER") {
    owner[id]=$3; events[id]++
  } else if (op == "TAG") {
    tags[id SUBSEP $3]=1; events[id]++
  } else if (op == "CLOSE") {
    state[id]="CLOSED"; events[id]++
  } else if (op == "REOPEN") {
    state[id]="OPEN"; events[id]++
  }
}
END {
  count=asorti(cases, ordered)
  for (i=1; i<=count; i++) {
    id=ordered[i]; delete one
    for (pair in tags) {
      split(pair, part, SUBSEP)
      if (part[1] == id) one[part[2]]=1
    }
    tag_count=asorti(one, tag_order); tag_text=""
    for (j=1; j<=tag_count; j++) tag_text=tag_text (j==1 ? "" : ",") tag_order[j]
    print id, owner[id], state[id], score[id], events[id], tag_text
  }
}

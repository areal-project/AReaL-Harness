#!/usr/bin/python3
import ctypes,json,sys
lib=ctypes.CDLL(sys.argv[1]);data=json.load(open(sys.argv[2],encoding='utf-8'))
def arr(xs):return (ctypes.c_double*len(xs))(*xs)
if data['kind']=='factor':
 n=data['n'];k=data['k'];w,r,e,fv,s=map(arr,(data['w'],data['r'],data['e'],data['f'],data['s']));before=tuple(map(bytes,(w,r,e,fv,s)));g=(ctypes.c_double*n)();a=ctypes.c_double();b=ctypes.c_double();fn=lib.factor_risk;P=ctypes.POINTER(ctypes.c_double);fn.argtypes=[ctypes.c_size_t,ctypes.c_size_t,P,P,P,P,P,P,P,P];fn.restype=ctypes.c_int;rc=fn(n,k,w,r,e,fv,s,ctypes.byref(a),ctypes.byref(b),g);result={'rc':rc,'return':a.value,'variance':b.value,'gradient':list(g),'preserved':before==tuple(map(bytes,(w,r,e,fv,s)))}
else:
 raise SystemExit(64)
sys.stdout.write(json.dumps(result,separators=(',',':'))+'\n')

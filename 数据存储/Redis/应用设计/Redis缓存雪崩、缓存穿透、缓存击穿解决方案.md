这些缓存常见异常问题，说实话，中小公司一般都遇不到，但如果是高并发项目，几百万流量的，就需要谨慎对待了。


# 1 缓存雪崩
## 1.1 什么是缓存雪崩?
由于
- 设置缓存时，key都采用了相同expire
- 更新策略
- 数据热点
- 缓存服务宕机

等原因，可能导致缓存数据同一时刻大规模不可用，或者都更新。

比如商城马上就要到双十一零点，很快就会迎来一波抢购，这波商品时间比较集中的放入了缓存，假设缓存一个小时。那么到了凌晨一点钟的时候，这批商品的缓存就都过期了。而对这批商品的访问查询，都落到了数据库上，对于数据库而言，就会产生周期性的压力波峰。

集中过期，其实不是太致命，最致命的是缓存服务器某个节点宕机：
- 自然形成的缓存雪崩，一定是在某个时间段集中创建缓存，那么这时DB也可顶住压力，无非就是对DB产生周期性压力
- 而缓存服务节点的宕机，这时所有缓存 key 都没了，请求全部打入 DB，对DB造成的压力不可预知，很可能瞬间就把DB压垮，这需要通过主从集群哨兵等解决。

做电商项目的时候，一般是采取不同分类商品，缓存不同周期。在同一分类中的商品，加上一个随机因子。这样能尽可能分散缓存过期时间，而且，热门类目的商品缓存时间长一些，冷门类目的商品缓存时间短一些，也能节省缓存服务的资源。

## 1.2 解决方案
- 更新策略在时间上做到比较均匀
- 使用的热数据尽量分散到不同的机器上
- 多台机器做主从复制或者多副本，实现高可用
### 服务降级
实现熔断限流机制，对系统进行负载能力控制

### 随机失效时间
在原有失效时间基础上增加一个随机值，比如1~5分钟的随机，这样每个缓存的过期时间重复率就会降低，集体失效概率也会大大降低。
### 互斥锁
### 双缓存
用得少。我们有两个缓存，缓存 A 和缓存 B。假设缓存 A 的失效时间为 20 分钟，缓存 B 不设失效时间。自己做缓存预热操作。然后：
a. 从缓存 A 读数据库，有则直接返回
b. A 没有数据，直接从 B 读数据，直接返回，并且异步启动一个更新线程。
c. 更新线程同时更新缓存 A 和缓存 B。
# 2 缓存穿透
## 2.1 什么是缓存穿透？
高并发查询不存在的key，导致将压力都直接透传到DB。

- 那为什么会多次透传呢？
因为缓存不存在该数据，一直为空。 

> 注意让缓存能够区分key 是不存在 or 查询得到一个空值。 
> 例如：访问**id=-1**的数据。可能出现绕过Redis频繁访问DB，称为缓存穿透，多出现在查询为null的情况不被缓存时。

## 2.2 解决方案
### 布隆过滤器（ Bloom过滤）或RoaringBitmap
提供一个能迅速判断请求是否有效的拦截机制。
比如利用布隆过滤器，内部维护一系列合法有效的 key。从而能迅速判断出，请求所携带的 Key 是否合法有效：
- 若不合法，则直接返回，避免直接查询DB。
### 缓存空值key
如果从数据库查询的对象为空，也放入缓存，只是设定的缓存过期时间较短，比如设置为 60 s。

这样第一次不存在也会被加载会记录，下次拿到有这个key。

### 完全以缓存为准
更简单粗暴的方法，若一个查询返回的数据为空（不管是数据不存在，还是系统故障），仍把该空结果进行缓存，但它的过期时间会很短，最长不超过5min。
```java
if(list == null) {
    // key value 有效时间 时间单位
    redisTemplate.opsForValue().set(navKey,null,10, TimeUnit.MINUTES);
} else {
    redisTemplate.opsForValue().set(navKey,result,7,TimeUnit.DAYS);
}
```
### 异步更新
使用 延迟异步加载 的策略2，这样业务前端不会触发更新，只有我们数据更新时后端去主动更新。

### 服务降级

### 互斥锁（不推荐）
问题根本在于限制处理线程的数量，即key的更新操作添加全局互斥锁。

在缓存失效时（判断拿出来的值为空），不是立即去load db，而是
- 先使用缓存工具的某些带成功操作返回值的操作（Redis的SETNX）去set一个mutex key
- 当操作返回成功时，再load db的操作并回设缓存；否则，就重试整个get缓存的方法。

```java
public String get(key) {
      String value = redis.get(key);
      if (value == null) { // 缓存已过期
          // 设置超时，防止del失败时，下次缓存过期一直不能load db
		  if (redis.setnx(key_mutex, 1, 3 * 60) == 1) { // 设置成功
               value = db.get(key);
                      redis.set(key, value, expire_secs);
                      redis.del(key_mutex);
          } else {
            		// 其他线程已load db并回设缓存，重试获取缓存即可
                    sleep(50);
                    get(key);  //重试
          }
        } else { // 缓存未过期
            return value;      
        }
 }
```

### 提前"使用互斥锁（不推荐）
在value内部设置1个超时值(timeout1)， timeout1比实际的memcache timeout(timeout2)小。当从cache读取到timeout1发现它已经过期时候，马上延长timeout1并重新设置到cache。然后再从数据库加载数据并设置到cache中。伪代码如下：

```java
v = memcache.get(key);  
if (v == null) {  
    if (memcache.add(key_mutex, 3 * 60 * 1000) == true) {  
        value = db.get(key);  
        memcache.set(key, value);  
        memcache.delete(key_mutex);  
    } else {  
        sleep(50);  
        retry();  
    }  
} else {  
    if (v.timeout <= now()) {  
        if (memcache.add(key_mutex, 3 * 60 * 1000) == true) {  
            // extend the timeout for other threads  
            v.timeout += 3 * 60 * 1000;  
            memcache.set(key, v, KEY_TIMEOUT * 2);  
  
            // load the latest value from db  
            v = db.get(key);  
            v.timeout = KEY_TIMEOUT;  
            memcache.set(key, value, KEY_TIMEOUT * 2);  
            memcache.delete(key_mutex);  
        } else {  
            sleep(50);  
            retry();  
        }  
    }  
} 
```

# 3 缓存击穿
- 击穿针对的是某一个key缓存
- 而雪崩是很多key

某key失效时，正好有高并发请求访问该key。 

通常使用【缓存 + 过期时间】帮助我们加速接口访问速度，减少后端负载，同时保证功能的更新，一般情况下这种模式已基本满足需求。

但若同时出现如下问题，可能对系统十分致命：
- 热点key，访问量非常大
比如秒杀时。
- 缓存的构建需要时间（可能是个复杂过程，例如复杂SQL、多次I/O、多个接口依赖）

于是就会导致：
在缓存失效瞬间，有大量线程构建缓存，导致后端负载加剧，甚至可能让系统崩溃。
![](https://img-blog.csdnimg.cn/20200911165012921.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3FxXzMzNTg5NTEw,size_16,color_FFFFFF,t_70#pic_center)
## 解决方案
缓存击穿，是指一个 key 非常热点，在不停的扛着大并发，大并发集中对这一个点进行访问，当这个 key 在失效的瞬间，持续的大并发就穿破缓存，直接请求数据库，就像在一个屏障上凿开了一个洞。做类电商项目的时候，把这货就称为 “爆款”。
其实，大多数情况下这种爆款很难对数据库服务器造成压垮性的压力。达到这个级别的公司没有几家的。所以，对主打商品都是早早的做好了准备，让缓存永不过期。即便某些商品自己发酵成了爆款，也是直接设为
### 永不过期

从 redis 上看，确实没有设置过期时间。这就保证不会出现热点 key 过期，即 “物理” 不过期

### “逻辑” 过期
功能上看，若不过期，不就成静态数据了？
所以我们把过期时间存在 key 对应的 value。若发现要过期了，通过一个后台异步线程进行缓存构建，即 “逻辑” 过期。

### 服务降级
### 缓存为准
使用异步线程负责维护缓存的数据，定期或根据条件触发更新，这样就不会触发更新。
### 限流
使用 Hystrix 或 Sentinel。

> 参考
> - https://www.iteye.com/blog/carlosfu-2269687
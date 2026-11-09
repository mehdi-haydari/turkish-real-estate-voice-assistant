# Emlak telefon asistanı — 20 senaryo

Bu senaryolar yerel deneme sayfasındaki **“Ses kullanmadan test et”** alanıyla çalıştırılır. Böylece LLM çıkarımı, takip sorusu seçimi ve portföy eşleştirmesi denenir. Bu sonuçlar Whisper'ın gerçek mikrofondan yaptığı ses tanımayı ölçmez.

Beklenen kayıt numaraları yalnızca `services/portfolio/data/sample_listings.json` içindeki kurgu örnek portföye göredir. Senaryolar her biri temiz görüşme durumunda başlatılır.

## Senaryolar

| # | Arayanın söylediği | Beklenen davranış |
|---|---|---|
| 1 | `Merhaba.` | Selamı karşılayıp ilan numarası veya konum sor; puan oluşmasın. |
| 2 | `Merhaba, kolay gelsin. Bilgi almak için aradım.` | Kibar karşıla; somut ilan bilgisi istemeye devam et. Genel niyet ilan ipucu sayılmasın. |
| 3 | `Sahibinden'de bir ilan gördüm, numarasını hatırlamıyorum.` | Numarayı tekrar isteme; sonraki ayırt edici bilgi olarak danışman adını sor ve ilanı eşleştirme. |
| 4 | `Sahibinden'de 12345678 numaralı ilanı gördüm.` | `12345678` ilanını bul ve son onay sorusunu sor. |
| 5 | `İlan numarası 12.34.56.78.` | Noktalı numarayı `12345678` olarak eşleştir. |
| 6 | `Sahibinden'de gördüm. On iki, otuz dört, elli altı, yetmiş sekiz.` | Sayıları `12345678` olarak birleştirip aynı ilanı bul. |
| 7 | `Kartal Ankara Caddesi'nde satılık 2+1 daire, üçüncü kat. Ayşe Hanım ilgileniyordu.` | `12345678` ilanını bul; Ayşe Hanım bilgisini koru. |
| 8 | `Afişte gördüm. Konum Kartal, Ankara Caddesi. Danışman Ayşe Hanım.` | `12345678` ilanını bul ve son onay iste. |
| 9 | `Ayşe Hanım'ın Kartal'daki 2+1 dairesi, üçüncü kattaydı.` | Ayşe Hanım'ın Kartal ilanı olan `12345678` kaydını ayırt et. |
| 10 | `Afişte Ayşe Hanım yazıyordu.` | Ayşe Hanım'ın iki örnek ilanı arasında seçim yapma; konum veya başka ayırt edici bilgi sor. |
| 11 | `Pendik Yenişehir'de kiralık, 2+1 daire. İkinci katta, metroya yakın.` | `22334455` ilanını bul ve son onay iste. |
| 12 | `Üsküdar Bağlarbaşı'nda Zeynep Hanım'ın satılık 3+1 dairesi.` | `11223344` ilanını bul ve son onay iste. |
| 13 | `Kadıköy Moda Caddesi'nde kiralık 1+1 daire. Bahçe katında.` | `87654321` ilanını bul; “bahçe katı”nı sayısal kat gibi yazma. |
| 14 | `Maltepe Altayçeşme'de bahçeli bir villa, yakınında park vardı.` | `33445566` en iyi aday olsun; tek başına puan yeterli değilse ek ayırt edici soru sor. |
| 15 | `Ahmet Bey'in Bakırköy Ataköy'deki satılık 2+1 dairesi.` | `66778899` ilanını bul ve son onay iste. |
| 16 | `Çekmeköy Taşdelen'de giriş katında, 2+1 daire. Yakınında park var.` | `88990011` ilanını bul; giriş katını kat `0` olarak ele al. |
| 17 | `İlanın yakınında metro istasyonu vardı.` | Metro ipucu `22334455` ve `55667788` kayıtlarını tek başına ayırmadığı için aday ilanı kesinleştirme; ek soru sor. |
| 18 | `Afişteki evin danışman adını ve konumunu bilmiyorum. Yakınında market vardı.` | Bilinmediği söylenen danışman/konumu tekrar tekrar sorma; başka ayırt edici bilgi sor. |
| 19 | `Sahibinden'de 12345678 numaralı ilan. Kartal'da, Ankara Caddesi'nde, Ayşe Hanım'ın 2+1 dairesi.` | `12345678` ilanını numara önceliğiyle bul; ekstradan danışman adı isteme. |
| 20 | `Bir ilan görmüştüm sahibinden. Onun için bilgi almak istiyordum.` | Bu genel cümleyi ipucu/puan sayma; Sahibinden ilan numarasını sor. |

## Çalıştırma sonucu

Yöntem: Her senaryo temiz tarayıcı oturumunda `http://127.0.0.1:8766/` sayfasındaki metin testine girildi. Gerçek yerel Qwen çıkarımı, takip sorusu seçimi ve portföy araması kullanıldı.

| # | Sonuç | Gözlem |
|---|---|---|
| 1 | PASS | Yalnız selamı karşıladı, ilan numarası veya konum sordu; arama puanı üretmedi. |
| 2 | PASS | Genel arama niyetini ipucu saymadı; puan üretmeden işlem türünü sordu. |
| 3 | PASS | Numaranın bilinmediğini kabul edip numarayı tekrarlamadı; danışman adını sordu. Soru gereğinden uzun/robotik çıktı. |
| 4 | PASS | Tam `12345678` numarasıyla doğru kaydı buldu; son onay istedi. |
| 5 | PASS | `12.34.56.78` değerini `12345678` yapıp doğru kaydı buldu. |
| 6 | PASS | Sayı sözcüklerini `12345678` yapıp doğru kaydı buldu. |
| 7 | PASS | Kartal, satılık, 2+1, üçüncü kat ve Ayşe bilgileriyle `12345678` kaydını buldu. |
| 8 | PASS | Afiş, Kartal/Ankara Caddesi ve Ayşe Hanım bilgileriyle `12345678` kaydını buldu. |
| 9 | FAIL | “Ayşe Hanım'ın Kartal'daki…” cümlesinden Kartal konumu ve danışman adını alanlara çıkarmadı; kayıt bulunamadı. |
| 10 | FAIL | “Afişte Ayşe Hanım yazıyordu” denmesine rağmen danışman adını yeniden sordu; verilen adı kullanmadı. |
| 11 | PASS | Kiralık, Pendik/Yenişehir, 2+1 ve ikinci kat ile `22334455` kaydını buldu. |
| 12 | PASS | Üsküdar, Zeynep Hanım, satılık ve 3+1 bilgileriyle `11223344` kaydını buldu. |
| 13 | PASS | Kadıköy/Moda, kiralık ve 1+1 bilgileriyle `87654321` kaydını buldu; bahçe katını sayısal kat yapmadı. |
| 14 | FAIL | Maltepe/Altayçeşme, villa ve park bilgilerini yapılandırılmış alanlara çıkarmadı; yalnız genel ipuçlarından 20 puan verdi. |
| 15 | PARTIAL | Doğru `66778899` kaydını buldu; “Ahmet Bey'in” ifadesini danışman adı alanına koymadı. Bu ifade danışman olduğunu açıkça söylemediğinden otomatik çıkarım belirsiz. |
| 16 | FAIL | Çekmeköy/Taşdelen ve giriş katını çıkaramadı; giriş katını `0` yapmadı ve ilgisiz biçimde satılık/kiralık sordu. |
| 17 | PASS | Tek metro ipucuyla kayıt seçmedi; ek ayırt edici bilgi olarak danışman adını sordu. |
| 18 | PASS | Bilinmediği belirtilen konum ve danışman adını tekrar sormadı; işlem türünü sordu. |
| 19 | PASS | Tam numarayı önceliklendirdi, `12345678` kaydını buldu ve ek danışman sorusu sormadı. |
| 20 | PASS | Genel “bilgi almak istiyorum” cümlesini eşleşme/puan saymadı; Sahibinden numarasını sordu. |

**Özet:** 15 PASS, 4 FAIL, 1 PARTIAL. En belirgin açık, açıkça söylenen danışman adını/konumu çıkaramama ve bazı cümlelerde alanları `other_clues`/`note` içine sıkıştırma.

**Test sınırı:** Bu tur metin testini kullandı; Whisper'ın mikrofon sesini yazıya çevirmesi test edilmedi. Bu nedenle 20 senaryo LLM ve portföy akışını ölçer, STT doğruluğunu değil.

